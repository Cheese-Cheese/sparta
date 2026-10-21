"""Caller-owned context tests; no network, credentials, or live models required."""
import copy
import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient

import brain
import ingest_github
import main
from analysis_context import MAX_CODE_CONTEXT_CHARS
from resume_limits import MAX_RESUME_CHARS


def snapshot(candidate):
    return {
        'resume_text': f'{candidate}: Experience building Python services. Skills: Python.',
        'code': f'--- FILE: {candidate}.py ---\ndef {candidate}_service(): pass',
        'has_github': True, 'repo_url': f'https://github.com/reader/{candidate}',
        'job_description': f'{candidate} job requirements',
        'interview_metadata': {'target_seniority': f'{candidate} Engineer'},
    }


class AnalysisIsolationTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        main.REPO_CACHE.clear()
        self.addCleanup(main.REPO_CACHE.clear)
        network = patch.object(ingest_github.requests, 'get', side_effect=AssertionError('Unexpected live GitHub request'))
        network.start()
        self.addCleanup(network.stop)

    def post(self, endpoint, context, **fields):
        return self.client.post(endpoint, json={'context': json.dumps(context), **fields})

    def test_interleaved_uploads_keep_legacy_operations_with_their_caller(self):
        saved = []
        for candidate in ('alice', 'bob'):
            data = snapshot(candidate)
            with patch.object(main, 'extract_text_intelligently', return_value=data['resume_text']), patch.object(
                brain, 'validate_is_resume', return_value=(True, '')
            ), patch.object(brain, 'analyze_resume_vs_code', return_value=json.dumps({'sections': {}})), patch.object(
                ingest_github, 'fetch_repo_content', return_value=data['code']
            ):
                result = self.client.post('/analyze', files={'file': ('resume.pdf', b'fixture', 'application/pdf')},
                                          data={'github_url': data['repo_url'], 'job_description': data['job_description']})
            self.assertEqual(result.status_code, 200)
            saved.append(json.loads(result.json()['data']))
        for index in (0, 1, 0):
            data = saved[index]
            with patch.object(brain, 'generate_interview_challenge', return_value='Question') as challenge, patch.object(
                brain, 'generate_ats_resume', return_value='Generated resume'
            ) as generate:
                self.assertEqual(self.post('/interview_start', data).status_code, 200)
                self.assertEqual(self.post('/generate_resume', data).status_code, 200)
            challenge.assert_called_once_with(data['code'], json.dumps(data))
            generate.assert_called_once_with(data['resume_text'], data['code'])

    def test_operations_work_without_a_previous_upload_or_process_record(self):
        data = snapshot('alice')
        # A different worker has no analysis or cache history.
        main.REPO_CACHE.clear()
        with patch.object(brain, 'generate_interview_challenge', return_value='Question') as challenge, patch.object(
            brain, 'generate_ats_resume', return_value='Resume'
        ) as generate:
            self.assertEqual(self.post('/interview_start', data).json()['question'], 'Question')
            self.assertEqual(self.post('/generate_resume', data).json()['resume'], 'Resume')
        self.assertIn('alice', challenge.call_args.args[1])
        self.assertIn('alice', generate.call_args.args[0])

    def test_resume_only_snapshots_work_without_repository_evidence(self):
        data = snapshot('alice')
        data.update(code='', has_github=False, repo_url=None)
        with patch.object(brain, 'generate_interview_challenge', return_value='Question') as challenge, patch.object(
            brain, 'generate_ats_resume', return_value='Resume'
        ) as generate:
            self.assertEqual(self.post('/interview_start', data).status_code, 200)
            self.assertEqual(self.post('/generate_resume', data).status_code, 200)
        self.assertEqual(challenge.call_args.args[0], '')
        self.assertEqual(generate.call_args.args, (data['resume_text'], ''))

    def test_add_repo_returns_updated_context_used_by_following_operations(self):
        alice, bob = snapshot('alice'), snapshot('bob')
        original = copy.deepcopy(alice)
        new_code = '--- FILE: queue.py ---\ndef queue_worker(): pass'
        with patch.object(ingest_github, 'fetch_repo_content', return_value=new_code), patch.object(
            brain, 'generate_star_bullets', return_value='Added queue workers'
        ):
            result = self.post('/add_repo', alice, github_url='https://github.com/reader/queue')
        self.assertEqual(result.status_code, 200)
        updated = result.json()['context']
        self.assertEqual(result.json()['bullets'], 'Added queue workers')
        self.assertFalse(result.json()['context_truncated'])
        self.assertIn(new_code, updated['code'])
        self.assertIn(original['code'], updated['code'])
        self.assertEqual(updated['resume_text'], alice['resume_text'])
        self.assertEqual(alice, original)
        self.assertNotIn('queue_worker', bob['code'])
        with patch.object(brain, 'generate_interview_challenge', return_value='Question') as challenge, patch.object(
            brain, 'generate_ats_resume', return_value='Resume'
        ) as generate, patch.object(brain, 'get_chat_response', return_value='Question') as chat:
            self.post('/interview_start', updated)
            self.post('/generate_resume', updated)
            self.post('/chat', updated, message='Answer')
        self.assertIn('queue_worker', challenge.call_args.args[0])
        self.assertIn('queue_worker', generate.call_args.args[1])
        self.assertIn('queue_worker', chat.call_args.args[3])

    def test_shared_repository_cache_never_reuses_candidate_resume_data(self):
        code = '--- FILE: shared.py ---\ndef shared_service(): pass'
        with patch.object(ingest_github, 'fetch_repo_content', return_value=code) as fetch, patch.object(
            brain, 'generate_star_bullets', return_value='Bullets'
        ):
            alice = self.post('/add_repo', snapshot('alice'), github_url='https://github.com/reader/shared').json()['context']
            bob = self.post('/add_repo', snapshot('bob'), github_url='https://github.com/reader/shared').json()['context']
        self.assertEqual(fetch.call_count, 1)
        self.assertIn('alice', alice['resume_text'])
        self.assertIn('bob', bob['resume_text'])
        self.assertNotIn('alice_service', bob['code'])
        self.assertNotIn('bob_service', alice['code'])

    def test_add_repo_updates_resume_only_context_and_clears_old_fetch_error(self):
        data = snapshot('alice')
        data.update(code='', has_github=False, repo_url=None, github_error='Old fetch failure')
        with patch.object(ingest_github, 'fetch_repo_content', return_value='--- FILE: api.py ---\nprint(1)'), patch.object(
            brain, 'generate_star_bullets', return_value='Bullets'
        ):
            result = self.post('/add_repo', data, github_url='https://github.com/reader/api')
        updated = result.json()['context']
        self.assertTrue(updated['has_github'])
        self.assertIsNone(updated['github_error'])
        self.assertEqual(updated['repo_url'], 'https://github.com/reader/api')

    def test_new_evidence_has_priority_and_truncation_is_reported(self):
        data = snapshot('alice')
        data['code'] = 'OLD_EVIDENCE' + 'x' * (MAX_CODE_CONTEXT_CHARS - len('OLD_EVIDENCE'))
        new_code = 'NEW_EVIDENCE' + 'y' * 25000
        with patch.object(ingest_github, 'fetch_repo_content', return_value=new_code), patch.object(
            brain, 'generate_star_bullets', return_value='Bullets'
        ):
            result = self.post('/add_repo', data, github_url='https://github.com/reader/new')
        self.assertEqual(result.status_code, 200)
        updated = result.json()['context']
        self.assertLessEqual(len(updated['code']), MAX_CODE_CONTEXT_CHARS)
        self.assertTrue(result.json()['context_truncated'])
        self.assertIn('NEW_EVIDENCE', updated['code'])
        self.assertIn('OLD_EVIDENCE', updated['code'])

    def test_all_context_endpoints_reject_missing_malformed_and_oversized_data_before_work(self):
        cases = [('', 400), ('{broken', 400), ('[]', 409), ('{}', 409),
                 (json.dumps({'resume_text': 'Resume', 'has_github': True}), 409),
                 (json.dumps({'resume_text': 'Resume', 'job_description': []}), 400),
                 (json.dumps({'resume_text': 'Resume', 'interview_metadata': []}), 400),
                 (json.dumps({'resume_text': 'x' * (MAX_RESUME_CHARS + 1)}), 413),
                 (json.dumps({'resume_text': 'Resume', 'code': 'x' * (MAX_CODE_CONTEXT_CHARS + 1)}), 413)]
        with patch.object(ingest_github, 'fetch_repo_content') as fetch, patch.object(
            brain, 'generate_star_bullets'
        ) as bullets, patch.object(brain, 'generate_interview_challenge') as challenge, patch.object(
            brain, 'generate_ats_resume'
        ) as generate, patch.object(brain, 'get_chat_response') as chat:
            for endpoint in ('/add_repo', '/interview_start', '/generate_resume', '/chat'):
                for context, status in cases:
                    with self.subTest(endpoint=endpoint, status=status):
                        result = self.client.post(endpoint, json={
                            'context': context, 'github_url': 'https://github.com/reader/new', 'message': 'Answer',
                        })
                        self.assertEqual(result.status_code, status)
            for operation in (fetch, bullets, challenge, generate, chat):
                operation.assert_not_called()

    def test_old_requests_without_context_fail_instead_of_reusing_last_upload(self):
        for endpoint in ('/interview_start', '/generate_resume'):
            self.assertEqual(self.client.post(endpoint).status_code, 422)
            self.assertEqual(self.client.post(endpoint, json={}).status_code, 400)
        self.assertEqual(self.client.post('/add_repo', json={'github_url': 'https://github.com/reader/new'}).status_code, 400)

    def test_fetch_failure_returns_502_without_changing_the_snapshot_or_cache(self):
        data = snapshot('alice')
        with patch.object(ingest_github, 'fetch_repo_content', side_effect=ingest_github.GitHubFetchError('GitHub returned HTTP 403.')), patch.object(
            brain, 'generate_star_bullets'
        ) as bullets:
            result = self.post('/add_repo', data, github_url='https://github.com/reader/new')
        self.assertEqual(result.status_code, 502)
        self.assertEqual(data, snapshot('alice'))
        self.assertEqual(len(main.REPO_CACHE), 0)
        bullets.assert_not_called()

    def test_empty_evidence_and_generation_failures_do_not_return_success_without_context(self):
        for code in ('', '--- FILE: api.py ---\nprint(1)'):
            with self.subTest(code=bool(code)), patch.object(
                ingest_github, 'fetch_repo_content', return_value=code
            ), patch.object(brain, 'generate_star_bullets', side_effect=RuntimeError('Generation unavailable')):
                result = self.post('/add_repo', snapshot('alice'), github_url='https://github.com/reader/new')
            self.assertEqual(result.status_code, 502)
            self.assertNotIn('context', result.json())

    def test_generate_resume_prompt_keeps_later_resume_content(self):
        data = snapshot('alice')
        data['resume_text'] += 'Earlier details. ' * 900 + 'LATER_PAGE_EVIDENCE'
        completion = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='Rewritten resume'))])
        create = Mock(return_value=completion)
        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
        with patch.object(brain, 'groq_client', client):
            result = self.post('/generate_resume', data)
        self.assertEqual(result.status_code, 200)
        self.assertIn('LATER_PAGE_EVIDENCE', create.call_args.kwargs['messages'][0]['content'])

    def test_extract_projects_returns_resume_text_to_the_caller(self):
        with patch.dict(os.environ, {'GROQ_API_KEY': 'test-placeholder'}), patch.object(
            main, 'extract_text_intelligently', return_value='Caller-owned resume'
        ), patch.object(main, 'analyze_with_groq', return_value=json.dumps({'identified_entity': 'Test candidate', 'extracted_data': []})):
            result = self.client.post('/extract_projects', files={'file': ('resume.pdf', b'fixture', 'application/pdf')})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()['resume_text'], 'Caller-owned resume')


if __name__ == '__main__':
    unittest.main()

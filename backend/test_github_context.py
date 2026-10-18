"""Offline regression tests for GitHub ingestion and interview evidence."""
import base64
import json
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import requests
from fastapi.testclient import TestClient

import brain
import ingest_github
import main


CODE = 'def total(items):\n    return sum(item.price for item in items)\n'
SOURCE = f'\n\n--- FILE: src/orders.py ---\n{CODE}'
RESUME = 'Experience: built an order API. Skills: Python. ' + 'Resume detail. ' * 100 + 'TAIL_EVIDENCE'
AUDIT = {'sections': {}, 'interview_metadata': {
    'target_seniority': 'Backend Engineer', 'phase1_domains': ['Order API', 'Python'],
    'phase2_domains': ['Redis'], 'ruthlessness_modifier': 'Ask for implementation details.',
}}


def response(payload, status=200):
    return SimpleNamespace(status_code=status, json=lambda: payload)


def blob(text=CODE):
    return response({'encoding': 'base64', 'content': base64.b64encode(text.encode()).decode()})


class GitHubIngestionTests(unittest.TestCase):
    def test_default_branch_and_public_access_without_token(self):
        tree = [{'path': 'src/orders.py', 'type': 'blob', 'size': len(CODE), 'sha': 'abc'}]
        with patch.object(ingest_github, 'GITHUB_TOKEN', None), patch.object(
            ingest_github.requests, 'get', side_effect=[response({'default_branch': 'develop'}), response({'tree': tree}), blob()]
        ) as get:
            result = ingest_github.fetch_repo_content('reader', 'orders')
        self.assertIn('--- FILE: src/orders.py ---', result)
        self.assertIn(CODE, result)
        self.assertIn('/git/trees/develop', get.call_args_list[1].args[0])
        self.assertNotIn('Authorization', get.call_args_list[0].kwargs['headers'])
        self.assertTrue(all(call.kwargs.get('timeout') for call in get.call_args_list))

    def test_explicit_branch_authentication_and_file_filters(self):
        tree = [
            {'path': 'src/orders.py', 'type': 'blob', 'size': 60, 'sha': 'abc'},
            {'path': 'node_modules/a.js', 'type': 'blob', 'size': 30, 'sha': 'dep'},
            {'path': 'logo.png', 'type': 'blob', 'size': 30, 'sha': 'image'},
            {'path': 'large.py', 'type': 'blob', 'size': 150001, 'sha': 'large'},
            {'path': 'folder.py', 'type': 'tree', 'sha': 'tree'},
        ]
        with patch.object(ingest_github, 'GITHUB_TOKEN', 'test-placeholder'), patch.object(
            ingest_github.requests, 'get', side_effect=[response({'tree': tree}), blob()]
        ) as get:
            text = ingest_github.fetch_repo_content('reader', 'orders', 'feature/api')
        self.assertEqual(get.call_count, 2)
        self.assertIn('feature%2Fapi', get.call_args_list[0].args[0])
        self.assertEqual(get.call_args_list[0].kwargs['headers']['Authorization'], 'Bearer test-placeholder')
        self.assertIn(CODE, text)

    def test_http_and_transport_failures_do_not_become_evidence(self):
        for outcome in [response({}, 401), response({}, 403), response({}, 404), requests.Timeout()]:
            with self.subTest(outcome=type(outcome).__name__), patch.object(
                ingest_github.requests, 'get', side_effect=[outcome]
            ), self.assertRaises(ingest_github.GitHubFetchError):
                ingest_github.fetch_repo_content('reader', 'orders')

    def test_empty_binary_and_truncated_results_are_explicit(self):
        cases = [
            [response({'tree': []})],
            [response({'tree': [], 'truncated': True})],
            [response({'tree': [{'path': 'a.py', 'type': 'blob', 'sha': 'a'}]}),
             response({'encoding': 'base64', 'content': '/w=='})],
            [response({'tree': [{'path': 'a.py', 'type': 'blob', 'sha': 'a'}]}), response({}, 403)],
        ]
        for replies in cases:
            with self.subTest(replies=len(replies)), patch.object(
                ingest_github.requests, 'get', side_effect=replies
            ), self.assertRaises(ingest_github.GitHubFetchError):
                ingest_github.fetch_repo_content('reader', 'orders', 'main')

    def test_file_and_character_budgets_stop_additional_downloads(self):
        tree = [{'path': f'{name}.py', 'type': 'blob', 'sha': name} for name in ('a', 'b')]
        for limits in [{'MAX_FILES': 1}, {'MAX_CONTEXT_CHARS': 35}]:
            with self.subTest(limits=limits), patch.multiple(ingest_github, **limits), patch.object(
                ingest_github.requests, 'get', side_effect=[response({'tree': tree}), blob()]
            ) as get:
                text = ingest_github.fetch_repo_content('reader', 'orders', 'main')
                self.assertEqual(get.call_count, 2)
                self.assertIn('--- FILE: a.py ---', text)
                self.assertNotIn('--- FILE: b.py ---', text)
                self.assertLessEqual(len(text), ingest_github.MAX_CONTEXT_CHARS)

    def test_bad_json_and_missing_default_branch_return_explicit_errors(self):
        bad_json = response({})
        bad_json.json = Mock(side_effect=ValueError('invalid json'))
        for reply in [bad_json, response({})]:
            with self.subTest(reply=reply), patch.object(ingest_github.requests, 'get', return_value=reply), self.assertRaises(
                ingest_github.GitHubFetchError
            ):
                ingest_github.fetch_repo_content('reader', 'orders')


class InterviewContextTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        main.DB.clear()
        main.REPO_CACHE.clear()
        self.temp = tempfile.TemporaryDirectory()
        self.previous_directory = os.getcwd()
        os.chdir(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(os.chdir, self.previous_directory)
        self.addCleanup(main.DB.clear)
        self.addCleanup(main.REPO_CACHE.clear)
        self.keys = patch.dict(os.environ, {'NVIDIA_API_KEY': 'test-placeholder'})
        self.keys.start()
        self.addCleanup(self.keys.stop)

    def analyze(self, resume=RESUME, code=SOURCE, url='https://github.com/reader/orders'):
        with patch.object(main, 'extract_text_intelligently', return_value=resume), patch.object(
            brain, 'validate_is_resume', return_value=(True, '')
        ), patch.object(brain, 'analyze_resume_vs_code', return_value=json.dumps(AUDIT)), patch.object(
            ingest_github, 'fetch_repo_content', return_value=code
        ) as fetch:
            result = self.client.post('/analyze', files={'file': ('resume.pdf', b'test', 'application/pdf')},
                                      data={'github_url': url, 'job_description': 'Build reliable order APIs with Redis.'})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()['status'], 'success')
        return json.loads(result.json()['data']), fetch

    def test_url_parser_handles_www_git_suffix_and_slash_branches(self):
        self.assertEqual(main.extract_github_details('https://www.github.com/reader/orders.git?tab=readme'),
                         ('reader', 'orders', None))
        self.assertEqual(main.extract_github_details('https://github.com/reader/orders/tree/feature/api'),
                         ('reader', 'orders', 'feature/api'))
        for url in ['https://github.com/reader', 'https://github.com.evil.test/a/b', 'https://gitlab.com/a/b', 'https://[broken']:
            self.assertEqual(main.extract_github_details(url), (None, None, None))

    def test_resume_profile_does_not_hide_later_repository_url(self):
        text = RESUME + ' https://github.com/reader https://github.com/reader/orders'
        data, fetch = self.analyze(resume=text, url='')
        fetch.assert_called_once_with('reader', 'orders', None)
        self.assertTrue(data['has_github'])

    def test_scraped_files_reach_actual_interview_model_after_json_handoff(self):
        tree = [{'path': 'src/orders.py', 'type': 'blob', 'size': len(CODE), 'sha': 'abc'}]
        with patch.object(main, 'extract_text_intelligently', return_value=RESUME), patch.object(
            brain, 'validate_is_resume', return_value=(True, '')
        ), patch.object(brain, 'analyze_resume_vs_code', return_value=json.dumps(AUDIT)) as audit, patch.object(
            ingest_github.requests, 'get', side_effect=[response({'default_branch': 'main'}), response({'tree': tree}), blob()]
        ):
            result = self.client.post('/analyze', files={'file': ('resume.pdf', b'test', 'application/pdf')},
                                      data={'github_url': 'https://github.com/reader/orders', 'job_description': 'Build order APIs with Redis.'})
        data = json.loads(result.json()['data'])
        self.assertIn(CODE, audit.call_args.args[1])
        # Simulate the browser's sessionStorage JSON round trip, then a worker restart.
        context = json.dumps(json.loads(json.dumps(data)))
        main.DB.clear()
        completion = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='[TOPIC: Intro] Introduce yourself.'))])
        create = Mock(return_value=completion)
        fake_client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
        with patch.object(brain, 'groq_client', fake_client):
            chat = self.client.post('/chat', json={'message': 'Start interview', 'history': [], 'context': context})
        self.assertEqual(chat.status_code, 200)
        prompt = create.call_args.kwargs['messages'][0]['content']
        for evidence in [CODE, 'src/orders.py', 'TAIL_EVIDENCE', 'Build order APIs with Redis.', 'Backend Engineer']:
            self.assertIn(evidence, prompt)

    def test_another_upload_cannot_replace_the_current_interview_evidence(self):
        first, _ = self.analyze()
        self.analyze(resume='Other candidate resume', code='--- FILE: other.py ---\nOTHER_CANDIDATE',
                     url='https://github.com/reader/other')
        with patch.object(brain, 'get_chat_response', return_value='Question') as chat:
            result = self.client.post('/chat', json={'message': 'Answer', 'history': [{'type': 'model', 'text': 'Question'}],
                                                     'context': json.dumps(first)})
        self.assertEqual(result.status_code, 200)
        evidence = chat.call_args.args[3]
        self.assertIn(CODE, evidence)
        self.assertNotIn('OTHER_CANDIDATE', evidence)
        self.assertNotIn('Other candidate resume', evidence)
        self.assertEqual(chat.call_args.args[0], [{'role': 'model', 'parts': ['Question']}])

    def test_fetch_failure_is_not_cached_or_marked_code_backed(self):
        with patch.object(main, 'extract_text_intelligently', return_value=RESUME), patch.object(
            brain, 'validate_is_resume', return_value=(True, '')
        ), patch.object(brain, 'analyze_resume_vs_code', return_value=json.dumps(AUDIT)), patch.object(
            ingest_github, 'fetch_repo_content', side_effect=ingest_github.GitHubFetchError('GitHub returned HTTP 403.')
        ) as fetch:
            for _ in range(2):
                result = self.client.post('/analyze', files={'file': ('resume.pdf', b'test', 'application/pdf')},
                                          data={'github_url': 'https://github.com/reader/orders'})
                data = json.loads(result.json()['data'])
                self.assertFalse(data['has_github'])
                self.assertEqual(data['code'], '')
                self.assertIn('403', data['github_error'])
        self.assertEqual(fetch.call_count, 2)
        self.assertEqual(len(main.REPO_CACHE), 0)

    def test_successful_repository_fetch_is_cached_even_for_short_source(self):
        self.analyze()
        _, fetch = self.analyze()
        fetch.assert_not_called()
        self.assertEqual(len(main.REPO_CACHE), 1)

    def test_missing_or_malformed_context_does_not_fall_back_to_shared_user(self):
        main.DB['current_user'] = {'resume': RESUME, 'code': SOURCE}
        for context in ['', '{broken', '{}', '[]', json.dumps({'resume_text': RESUME, 'has_github': True})]:
            with self.subTest(context=context[:10]), patch.object(brain, 'get_chat_response') as chat:
                result = self.client.post('/chat', json={'message': 'Answer', 'context': context})
                self.assertIn(result.status_code, (400, 409))
                chat.assert_not_called()

    def test_resume_only_interview_retains_resume_and_job_description(self):
        data, fetch = self.analyze(resume=RESUME, url='')
        fetch.assert_not_called()
        self.assertFalse(data['has_github'])
        with patch.object(brain, 'get_chat_response', return_value='Question') as chat:
            result = self.client.post('/chat', json={'message': 'Start', 'context': json.dumps(data)})
        self.assertEqual(result.status_code, 200)
        self.assertIn('TAIL_EVIDENCE', chat.call_args.args[3])
        self.assertIn('NO CODE PROVIDED', chat.call_args.args[3])


if __name__ == '__main__':
    unittest.main()

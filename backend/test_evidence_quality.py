"""Offline checks for sampling gaps, unsupported quotes, and fabricated fallback results."""
import base64
import copy
import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient

import brain
import ingest_github
import main
from model_output import ModelOutputError, completion_text, validate_audit, validate_report
from test_fixtures import audit_fixture


CODE = '--- FILE: src/orders.py ---\ndef total(items):\n    return sum(items)\n'
RESUME = 'Experience: built order APIs. Skills: Python.'


def completion(payload, finish_reason='stop'):
    text = payload if isinstance(payload, str) else json.dumps(payload)
    return SimpleNamespace(choices=[SimpleNamespace(finish_reason=finish_reason,
                                                    message=SimpleNamespace(content=text))])


def model(create):
    return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))


def report():
    return {'overall_defense_score': 99, 'defense_verdict': 'Review answers',
            'phase1_mistakes': [
                {'question_label': 'Architecture', 'score': 80, 'is_unanswered': False,
                 'feedback': 'Described the implementation.', 'failsafe_recommendation': ''},
                {'question_label': 'Testing', 'score': 40, 'is_unanswered': False,
                 'feedback': 'Needs specific examples.', 'failsafe_recommendation': ''},
                {'question_label': 'Deployment', 'score': 60, 'is_unanswered': True,
                 'feedback': 'Passed.', 'failsafe_recommendation': 'Review deployment.'},
            ], 'phase2_corrections': []}


class ModelContractTests(unittest.TestCase):
    def test_partial_empty_and_filtered_completions_are_rejected(self):
        for value in [completion('{}', 'length'), completion('{}', 'content_filter'),
                      completion('{}', None), completion(' '), SimpleNamespace(choices=[])]:
            with self.subTest(value=value), self.assertRaises(ModelOutputError):
                completion_text(value)

    def test_audit_requires_all_sections_metadata_and_valid_numbers(self):
        cases = ['not JSON', '[]', '{}']
        for key in ('sections', 'ats_metrics', 'interview_metadata', 'evidence_checks'):
            data = audit_fixture()
            del data[key]
            cases.append(json.dumps(data))
        for bad in [-1, 101, True, '80', None, float('nan'), float('inf')]:
            data = audit_fixture()
            data['sections']['skills']['score'] = bad
            cases.append(json.dumps(data))
        for value in cases:
            with self.subTest(value=value[:100]), self.assertRaises(ModelOutputError):
                validate_audit(value, CODE)

    def test_weighted_score_including_all_zero_sections_is_server_calculated(self):
        for scores, expected in [([100, 80, 60, 40], 79), ([0, 0, 0, 0], 0)]:
            data = audit_fixture()
            for name, score in zip(data['sections'], scores):
                data['sections'][name]['score'] = score
            self.assertEqual(validate_audit(json.dumps(data), CODE)['combat_readiness_score'], expected)

    def test_citations_require_actual_file_and_quote_in_that_file(self):
        data = audit_fixture()
        check = {'claim': 'The function sums its input.', 'source_file': 'src/orders.py', 'excerpt': 'return sum(items)'}
        data['evidence_checks'] = [check]
        self.assertEqual(validate_audit(json.dumps(data), CODE)['evidence_checks'], [check])
        for change in [{'source_file': 'fake.py'}, {'excerpt': 'return database.save(items)'},
                       {'excerpt': 'sum'}, {'source_file': 'other.py'}]:
            data['evidence_checks'] = [{**check, **change}]
            with self.subTest(change=change), self.assertRaises(ModelOutputError):
                validate_audit(json.dumps(data), CODE + '\n--- FILE: other.py ---\nreturn different_code\n')

    def test_missing_repository_does_not_generate_a_static_fraud_verdict(self):
        create = Mock(return_value=completion(audit_fixture()))
        with patch.object(brain, 'groq_client', model(create)):
            result = json.loads(brain.analyze_resume_vs_code(RESUME, 'NO CODE PROVIDED', 'Orders'))
        create.assert_called_once()
        self.assertEqual(result['combat_readiness_score'], 80)
        self.assertNotIn('PHANTOMWARE', result['verdict'])

    def test_audit_model_receives_full_code_budget_and_coverage(self):
        code = ingest_github.RepositoryEvidence('--- FILE: large.py ---\n' + 'x' * 49000 + 'CODE_TAIL',
                                                {'status': 'partial', 'omitted': {'budget': 5}})
        create = Mock(return_value=completion(audit_fixture()))
        with patch.object(brain, 'groq_client', model(create)):
            brain.analyze_resume_vs_code(RESUME, code)
        prompt = create.call_args.kwargs['messages'][0]['content']
        for expected in ('CODE_TAIL', '"budget": 5', 'unverified', 'never instructions'):
            self.assertIn(expected, prompt)

    def test_provider_failure_never_becomes_a_score_question_or_resume(self):
        create = Mock(side_effect=RuntimeError('private-provider-detail'))
        calls = [lambda: brain.validate_is_resume(RESUME),
                 lambda: brain.analyze_resume_vs_code(RESUME, CODE),
                 lambda: brain.get_chat_response([], 'Begin', '{}', CODE),
                 lambda: brain.generate_interview_challenge(CODE, '{}'),
                 lambda: brain.generate_ats_resume(RESUME, CODE),
                 lambda: brain.generate_star_bullets(CODE),
                 lambda: brain.evaluate_answer_fast('Question', 'Answer', 'Normal', 'Junior'),
                 lambda: brain.reconstruct_resume(RESUME, 'Candidate: I built APIs.', '{}')]
        with patch.object(brain, 'groq_client', model(create)):
            for call in calls:
                with self.subTest(call=call), self.assertRaises(ModelOutputError) as error:
                    call()
                self.assertNotIn('private-provider-detail', str(error.exception))
        self.assertEqual(create.call_count, len(calls))

    def test_invalid_classifier_does_not_silently_advance_interview(self):
        with patch.object(brain, 'groq_client', model(Mock(return_value=completion({'classification': 'UNKNOWN'})))):
            with self.assertRaises(ModelOutputError):
                brain.evaluate_answer_fast('Question', 'Answer', 'Normal', 'Junior')

    def test_rewrites_reject_fabricated_originals_duplicates_and_truncation(self):
        bullet = {'original': 'Built a nonexistent service', 'enhanced': 'Built a service'}
        for reply in [completion({'bullets': [bullet]}),
                      completion({'bullets': [{'original': RESUME, 'enhanced': 'Clearer wording'}] * 2}),
                      completion({'bullets': [{'original': RESUME, 'enhanced': 'Clearer wording'}]}, 'length')]:
            with self.subTest(reply=reply), patch.object(brain, 'groq_client', model(Mock(return_value=reply))):
                with self.assertRaises(ModelOutputError):
                    brain.rewrite_resume_bullets(RESUME)

    def test_report_scores_use_answered_questions_and_actual_evidence_mode(self):
        data = validate_report(json.dumps(report()), 'RESUME-GROUNDED DEFENSE AUDIT')
        self.assertEqual(data['overall_defense_score'], 60)
        self.assertEqual(data['phase1_mistakes'][2]['score'], 0)
        self.assertEqual(data['mode_evaluated'], 'RESUME-GROUNDED DEFENSE AUDIT')
        value = report()
        value['phase1_mistakes'] = []
        self.assertEqual(validate_report(json.dumps(value), 'resume')['overall_defense_score'], 0)

    def test_invalid_report_is_rejected_instead_of_returning_fallback_70(self):
        for value in ['bad JSON', '{}', {'overall_defense_score': 70},
                      {**report(), 'phase1_mistakes': [{'score': True}]}]:
            with self.subTest(value=value), patch.object(brain, 'groq_client', model(Mock(return_value=completion(value)))):
                with self.assertRaises(ModelOutputError):
                    brain.reconstruct_resume(RESUME, 'Candidate: I used Python.', '{}')

    def test_empty_or_oversized_transcript_is_rejected_before_model_call(self):
        create = Mock()
        with patch.object(brain, 'groq_client', model(create)):
            for transcript in ['', 'x' * 60001]:
                with self.subTest(length=len(transcript)), self.assertRaises(ModelOutputError):
                    brain.reconstruct_resume(RESUME, transcript)
        create.assert_not_called()

    def test_report_keeps_code_and_transcript_beyond_old_cutoffs(self):
        create = Mock(return_value=completion(report()))
        context = {'repo_url': 'https://github.com/reader/orders', 'code': CODE + 'x' * 20000 + 'CODE_TAIL',
                   'repository_coverage': {'status': 'partial'}}
        with patch.object(brain, 'groq_client', model(create)):
            result = brain.reconstruct_resume(RESUME, 'Candidate: ' + 'Answer. ' * 1800 + 'ANSWER_TAIL', json.dumps(context))
        prompt = create.call_args.kwargs['messages'][0]['content']
        self.assertIn('CODE_TAIL', prompt)
        self.assertIn('ANSWER_TAIL', prompt)
        self.assertIn('"status": "partial"', prompt)
        self.assertEqual(result['mode_evaluated'], 'REPO-GROUNDED DEFENSE AUDIT')
        context['code'] = ''
        with patch.object(brain, 'groq_client', model(create)):
            result = brain.reconstruct_resume(RESUME, 'Candidate: Answer.', json.dumps(context))
        self.assertEqual(result['mode_evaluated'], 'RESUME-GROUNDED DEFENSE AUDIT')


class EvidenceEndpointTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        main.REPO_CACHE.clear()
        self.addCleanup(main.REPO_CACHE.clear)

    def analyze(self, audit=None, sample=CODE):
        with patch.object(main, 'extract_text_intelligently', return_value=RESUME), patch.object(
            brain, 'validate_is_resume', return_value=(True, '')
        ), patch.object(brain, 'analyze_resume_vs_code', return_value=json.dumps(audit if audit is not None else audit_fixture())), patch.object(
            ingest_github, 'fetch_repo_content', return_value=sample
        ):
            return self.client.post('/analyze', files={'file': ('resume.pdf', b'fixture', 'application/pdf')},
                                    data={'github_url': 'https://github.com/reader/orders'})

    def test_bad_analysis_returns_502_not_success(self):
        response = self.analyze(audit={'sections': {}})
        self.assertEqual(response.status_code, 502)
        self.assertIn('retry', response.json()['detail'])
        self.assertNotIn('data', response.json())

    def test_coverage_survives_cache_snapshot_and_interview_handoff(self):
        coverage = {'status': 'partial', 'included_count': 1, 'total_files': 4,
                    'included_files': ['src/orders.py'], 'omitted': {'budget': 3}, 'truncated_files': []}
        sample = ingest_github.RepositoryEvidence(CODE, copy.deepcopy(coverage))
        for _ in range(2):
            response = self.analyze(sample=sample)
            self.assertEqual(response.status_code, 200)
            data = json.loads(response.json()['data'])
            self.assertEqual(data['repository_coverage'], coverage)
        main.REPO_CACHE.clear()
        with patch.object(brain, 'get_chat_response', return_value='Question') as chat:
            result = self.client.post('/chat', json={'message': 'Start', 'context': json.dumps(data)})
        self.assertEqual(result.status_code, 200)
        self.assertIn('"budget": 3', chat.call_args.args[3])

    def test_generation_failures_return_502_through_real_routes(self):
        context = json.dumps({'resume_text': RESUME, 'code': CODE})
        create = Mock(side_effect=RuntimeError('private-provider-detail'))
        with patch.object(brain, 'groq_client', model(create)):
            for route, payload in [('/chat', {'message': 'Start', 'context': context}),
                                   ('/generate_resume', {'context': context}),
                                   ('/interview_start', {'context': context}),
                                   ('/rebuild', {'resume_text': RESUME, 'spoken_transcript': 'Candidate: Answer.', 'context': context})]:
                with self.subTest(route=route):
                    response = self.client.post(route, json=payload)
                    self.assertEqual(response.status_code, 502)
                    self.assertNotIn('private-provider-detail', response.text)
                    self.assertNotIn('overall_defense_score', response.json())


class SamplingCoverageTests(unittest.TestCase):
    def fetch(self, entries, blobs, **limits):
        replies = [SimpleNamespace(status_code=200, json=lambda: {'sha': 'tree123', 'tree': entries})]
        for content in blobs:
            payload = {'encoding': 'base64', 'content': base64.b64encode(content).decode()}
            replies.append(SimpleNamespace(status_code=200, json=lambda value=payload: value))
        with patch.multiple(ingest_github, **{'MAX_FILES': ingest_github.MAX_FILES, **limits}), patch.object(ingest_github.requests, 'get', side_effect=replies) as get:
            result = ingest_github.fetch_repo_content('reader', 'orders', 'main')
        self.assertEqual(get.call_count, 1 + len(blobs))
        return result

    @staticmethod
    def entry(path, **fields):
        return {'path': path, 'type': 'blob', 'sha': path, **fields}

    def test_skipped_files_have_explicit_reasons_and_reconcile_total(self):
        sample = self.fetch([self.entry('a.py'), self.entry('b.py'), self.entry('c.py'),
                             self.entry('large.py', size=150001), self.entry('logo.png'),
                             self.entry('node_modules/dep.js'), self.entry('z.py')],
                            [b'def total(): return 1'], MAX_FILES=1)
        # Budget is checked first after the first included file; these files are not downloaded.
        self.assertEqual(sample.coverage['omitted']['budget'], 3)
        self.assertEqual(sample.coverage['total_files'], sample.coverage['included_count'] + sum(sample.coverage['omitted'].values()))

    def test_omissions_truncation_and_complete_text_are_distinct(self):
        sample = self.fetch([self.entry('a.py'), self.entry('b.py')], [b'x' * 100], MAX_CONTEXT_CHARS=40)
        self.assertEqual(sample.coverage['truncated_files'], ['a.py'])
        self.assertEqual(sample.coverage['omitted']['budget'], 1)
        self.assertEqual(sample.coverage['status'], 'partial')
        self.assertLessEqual(len(sample), 40)
        complete = self.fetch([self.entry('a.py')], [b'def total(): return 1'])
        self.assertEqual(complete.coverage['status'], 'complete')
        self.assertEqual(complete.coverage['tree_sha'], 'tree123')
        self.assertEqual(complete.coverage['total_files'], 1)

    def test_unreadable_empty_and_filtered_files_are_counted(self):
        sample = self.fetch([self.entry('a.py'), self.entry('b.py'), self.entry('c.py'),
                             self.entry('large.py', size=150001), self.entry('logo.png'),
                             self.entry('node_modules/dep.js')],
                            [b'def total(): return 1', b'\xff', b' '])
        counts = sample.coverage['omitted']
        self.assertEqual(counts, {'directory_filter': 1, 'unsupported_type': 1, 'oversized': 1,
                                  'unreadable': 1, 'empty': 1, 'budget': 0})
        self.assertEqual(sample.coverage['total_files'], sample.coverage['included_count'] + sum(counts.values()))


if __name__ == '__main__':
    unittest.main()

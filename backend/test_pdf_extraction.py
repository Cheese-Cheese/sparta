"""Offline multi-page extraction and /analyze regression tests."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pymupdf
import requests
from fastapi.testclient import TestClient

import brain
import ingest_github
import main
import pipeline
from resume_limits import MAX_RESUME_PAGES, MAX_RESUME_CHARS, MAX_RESUME_BYTES


def pdf_bytes(texts, scanned_pages=()):
    with pymupdf.open() as document:
        for index, text in enumerate(texts):
            page = document.new_page()
            if index in scanned_pages:
                with pymupdf.open() as raster_source:
                    source_page = raster_source.new_page()
                    source_page.insert_text((72, 72), text)
                    image = source_page.get_pixmap().tobytes('png')
                page.insert_image(page.rect, stream=image)
            else:
                page.insert_textbox(pymupdf.Rect(40, 40, 550, 800), text, fontsize=10)
        return document.tobytes()


class PdfExtractionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'resume.pdf'
        network = patch.object(pipeline.requests, 'post', side_effect=AssertionError('Unexpected live OCR request'))
        network.start()
        self.addCleanup(network.stop)

    def save(self, texts, scanned_pages=()):
        self.path.write_bytes(pdf_bytes(texts, scanned_pages))

    def test_reads_all_twenty_pages_in_order_without_ocr(self):
        texts = [f'PAGE_{index:02d}: Experience building reliable Python APIs and database systems.'
                 for index in range(1, MAX_RESUME_PAGES + 1)]
        self.save(texts)
        with patch.object(pipeline.requests, 'post') as ocr:
            result = pipeline.extract_text_intelligently(str(self.path), '')
        positions = [result.index(f'PAGE_{index:02d}') for index in range(1, MAX_RESUME_PAGES + 1)]
        self.assertEqual(positions, sorted(positions))
        ocr.assert_not_called()

    def test_preserves_short_native_pages_and_skips_blank_pages(self):
        self.save(['Experience: Python engineer.', '', 'Skills: SQL.'])
        with patch.object(pipeline.requests, 'post') as ocr:
            result = pipeline.extract_text_intelligently(str(self.path), '')
        self.assertIn('Experience: Python engineer.', result)
        self.assertIn('Skills: SQL.', result)
        ocr.assert_not_called()

    def test_single_page_selection_still_works(self):
        self.save(['First page experience.', 'Second page skills.'])
        result = pipeline.extract_text_intelligently(str(self.path), '', page_number=1)
        self.assertIn('Second page', result)
        self.assertNotIn('First page', result)

    def test_mixed_pdf_uses_ocr_only_on_the_scanned_page(self):
        self.save(['Experience: built Python APIs with SQL databases.', 'Scanned work history.',
                   'Projects: deployed backend services.'], scanned_pages=(1,))
        reply = SimpleNamespace(status_code=200, json=lambda: {'data': [{'text': 'OCR_PAGE_TWO: built queue workers.'}]})
        with patch.object(pipeline.requests, 'post', return_value=reply) as ocr:
            result = pipeline.extract_text_intelligently(str(self.path), 'test-placeholder')
        self.assertLess(result.index('Experience:'), result.index('OCR_PAGE_TWO:'))
        self.assertLess(result.index('OCR_PAGE_TWO:'), result.index('Projects:'))
        self.assertEqual(ocr.call_count, 1)
        self.assertTrue(ocr.call_args.kwargs.get('timeout'))

    def test_page_limit_rejects_instead_of_silently_dropping_pages(self):
        self.save(['Skills: Python.'] * (MAX_RESUME_PAGES + 1))
        with patch.object(pipeline.requests, 'post') as ocr, self.assertRaisesRegex(
            pipeline.ResumeExtractionError, '20 pages'
        ):
            pipeline.extract_text_intelligently(str(self.path), '')
        ocr.assert_not_called()

    def test_text_limit_rejects_instead_of_cutting_off_the_last_page(self):
        self.save(['Experience: Python.'] * 2)
        with patch.object(pipeline, 'MAX_RESUME_CHARS', 25), self.assertRaisesRegex(
            pipeline.ResumeExtractionError, '25 characters'
        ):
            pipeline.extract_text_intelligently(str(self.path), '')

    def test_exact_character_limit_is_accepted_and_the_next_character_is_rejected(self):
        self.save(['Experience: Python.'])
        for length in (MAX_RESUME_CHARS, MAX_RESUME_CHARS + 1):
            with self.subTest(length=length), patch.object(pipeline, '_extract_page_text', return_value='A' * length):
                if length == MAX_RESUME_CHARS:
                    self.assertEqual(len(pipeline.extract_text_intelligently(str(self.path), '')), length)
                else:
                    with self.assertRaises(pipeline.ResumeExtractionError) as failure:
                        pipeline.extract_text_intelligently(str(self.path), '')
                    self.assertEqual(failure.exception.status_code, 413)

    def test_ocr_failure_does_not_return_partial_resume_text(self):
        self.save(['Experience: Python.', 'Scanned text.'], scanned_pages=(1,))
        for reply in [SimpleNamespace(status_code=503), requests.Timeout(),
                      SimpleNamespace(status_code=200, json=lambda: {'data': []})]:
            with self.subTest(reply=type(reply).__name__), patch.object(
                pipeline.requests, 'post', side_effect=[reply]
            ), self.assertRaisesRegex(pipeline.ResumeExtractionError, 'page 2'):
                pipeline.extract_text_intelligently(str(self.path), 'test-placeholder')

    def test_missing_ocr_key_is_only_an_error_for_scanned_pages(self):
        self.save(['Scanned text.'], scanned_pages=(0,))
        with patch.object(pipeline.requests, 'post') as ocr, self.assertRaisesRegex(
            pipeline.ResumeExtractionError, 'NVIDIA_API_KEY'
        ):
            pipeline.extract_text_intelligently(str(self.path), '')
        ocr.assert_not_called()

    def test_blank_invalid_and_password_protected_pdfs_are_explicit(self):
        self.save([''])
        with self.assertRaises(pipeline.ResumeExtractionError):
            pipeline.extract_text_intelligently(str(self.path), '')
        self.path.write_bytes(b'not a PDF')
        with self.assertRaises(pipeline.ResumeExtractionError):
            pipeline.extract_text_intelligently(str(self.path), '')
        with pymupdf.open() as document:
            document.new_page().insert_text((72, 72), 'Password-protected resume.')
            self.path.write_bytes(document.tobytes(encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw='fixture-password'))
        with self.assertRaisesRegex(pipeline.ResumeExtractionError, 'password'):
            pipeline.extract_text_intelligently(str(self.path), '')


class AnalyzeMultipageTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        network = patch.object(pipeline.requests, 'post', side_effect=AssertionError('Unexpected live OCR request'))
        network.start()
        self.addCleanup(network.stop)
        main.REPO_CACHE.clear()
        self.addCleanup(main.REPO_CACHE.clear)

    def test_last_page_reaches_audit_github_detection_and_interview(self):
        # Put the long text on several real PDF pages, well past old prompt limits.
        texts = ['Experience: Python APIs. Skills: SQL.\n' + 'Earlier project detail.\n' * 45] * 14
        last = 'FINAL_PAGE_EVIDENCE: queue workers at scale.\nhttps://github.com/reader/orders'
        document = pdf_bytes(texts + [last])
        def completion(**kwargs):
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps({
                'sections': {'skills': {'score': 80}}, 'interview_metadata': {'target_seniority': 'Engineer'},
            })))])
        create = Mock(side_effect=completion)
        fake_client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
        with patch.dict(os.environ, {'NVIDIA_API_KEY': ''}), patch.object(
            brain, 'validate_is_resume', return_value=(True, '')
        ), patch.object(brain, 'groq_client', fake_client), patch.object(
            ingest_github, 'fetch_repo_content', return_value='--- FILE: worker.py ---\ndef work(): pass'
        ) as github, patch.object(pipeline.requests, 'post') as ocr:
            result = self.client.post('/analyze', files={'file': ('resume.pdf', document, 'application/pdf')})
        self.assertEqual(result.status_code, 200, result.text)
        data = json.loads(result.json()['data'])
        self.assertGreater(data['resume_text'].index('FINAL_PAGE_EVIDENCE'), 12000)
        self.assertIn('FINAL_PAGE_EVIDENCE', create.call_args.kwargs['messages'][0]['content'])
        github.assert_called_once_with('reader', 'orders', None)
        ocr.assert_not_called()
        main.REPO_CACHE.clear()
        with patch.object(brain, 'get_chat_response', return_value='Question') as chat:
            result = self.client.post('/chat', json={'message': 'Start', 'context': json.dumps(data)})
        self.assertEqual(result.status_code, 200)
        self.assertIn('FINAL_PAGE_EVIDENCE', chat.call_args.args[3])

    def test_too_many_pages_returns_413_before_model_or_ocr_calls(self):
        with patch.object(brain, 'validate_is_resume') as validate, patch.object(pipeline.requests, 'post') as ocr:
            result = self.client.post('/analyze', files={'file': (
                'resume.pdf', pdf_bytes(['Skills: Python.'] * (MAX_RESUME_PAGES + 1)), 'application/pdf'
            )})
        self.assertEqual(result.status_code, 413)
        self.assertIn('20 pages', result.json()['detail'])
        validate.assert_not_called()
        ocr.assert_not_called()

    def test_file_limit_returns_413_before_extraction(self):
        with patch.object(main, 'extract_text_intelligently') as extract:
            result = self.client.post('/analyze', files={'file': ('resume.pdf', b'x' * (MAX_RESUME_BYTES + 1), 'application/pdf')})
        self.assertEqual(result.status_code, 413)
        extract.assert_not_called()

    def test_invalid_pdf_returns_actionable_http_error(self):
        result = self.client.post('/analyze', files={'file': ('resume.pdf', b'invalid', 'application/pdf')})
        self.assertEqual(result.status_code, 422)
        self.assertIn('PDF', result.json()['detail'])

    def test_temporary_file_is_removed_after_extraction_failure(self):
        paths = []
        real_tempfile = tempfile.NamedTemporaryFile
        def capture(**kwargs):
            handle = real_tempfile(**kwargs)
            paths.append(handle.name)
            return handle
        with patch.object(main.tempfile, 'NamedTemporaryFile', side_effect=capture):
            result = self.client.post('/analyze', files={'file': ('resume.pdf', b'invalid', 'application/pdf')})
        self.assertEqual(result.status_code, 422)
        self.assertEqual(len(paths), 1)
        self.assertFalse(Path(paths[0]).exists())


if __name__ == '__main__':
    unittest.main()

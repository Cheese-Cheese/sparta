import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

import brain
import main


class ReconstructionTests(unittest.TestCase):
    def completion(self, payload):
        return SimpleNamespace(choices=[SimpleNamespace(finish_reason='stop',
            message=SimpleNamespace(content=json.dumps(payload))
        )])

    def test_rewrite_returns_original_and_enhanced_bullets(self):
        payload = {"bullets": [{"original": "Built an API", "enhanced": "Developed an API"}]}
        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(
            create=lambda **kwargs: self.completion(payload)
        )))
        with patch.object(brain, "groq_client", client):
            self.assertEqual(brain.rewrite_resume_bullets("Built an API"), payload)

    def test_rewrite_rejects_report_and_malformed_bullets(self):
        for payload in ({"phase2_corrections": []}, {"bullets": []},
                        {"bullets": [{"original": "Built an API", "enhanced": None}]}):
            with self.subTest(payload=payload):
                client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(
                    create=lambda **kwargs: self.completion(payload)
                )))
                with patch.object(brain, "groq_client", client), self.assertRaises(ValueError):
                    brain.rewrite_resume_bullets("Built an API")

    def test_resume_mode_uses_rewrite(self):
        payload = {"bullets": [{"original": "Built an API", "enhanced": "Developed an API"}]}
        with patch.object(brain, "rewrite_resume_bullets", return_value=payload) as rewrite:
            result = asyncio.run(main.rebuild_endpoint(main.RebuildRequest(
                resume_text="Built an API", mode="resume"
            )))
        self.assertEqual(result, payload)
        rewrite.assert_called_once_with("Built an API")

    def test_existing_interview_request_preserves_report(self):
        report = {"overall_defense_score": 82, "phase2_corrections": []}
        with patch.object(main, "reconstruct_resume", return_value=report) as reconstruct:
            result = asyncio.run(main.rebuild_endpoint(main.RebuildRequest(
                resume_text="Built an API", spoken_transcript="I used Python"
            )))
        self.assertEqual(result, report)
        reconstruct.assert_called_once_with("Built an API", "I used Python", "")

    def test_empty_resume_is_rejected_before_ai_request(self):
        with patch.object(brain, "rewrite_resume_bullets") as rewrite:
            with self.assertRaises(HTTPException) as failure:
                asyncio.run(main.rebuild_endpoint(main.RebuildRequest(resume_text=" ", mode="resume")))
        self.assertEqual(failure.exception.status_code, 400)
        rewrite.assert_not_called()

    def test_ai_failure_returns_error_instead_of_success_report(self):
        with patch.object(brain, "rewrite_resume_bullets", side_effect=ValueError("invalid output")):
            with self.assertLogs(main.logger, level="ERROR"), self.assertRaises(HTTPException) as failure:
                asyncio.run(main.rebuild_endpoint(main.RebuildRequest(resume_text="Built an API", mode="resume")))
        self.assertEqual(failure.exception.status_code, 502)


if __name__ == "__main__":
    unittest.main()

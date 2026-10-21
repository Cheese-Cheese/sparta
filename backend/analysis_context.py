"""Validate caller-owned analysis snapshots shared by the resume endpoints."""
import json

from fastapi import HTTPException

from resume_limits import MAX_RESUME_CHARS

MAX_CODE_CONTEXT_CHARS = 50000


def parse_analysis_context(value: str) -> dict:
    try:
        context = json.loads(value)
    except (TypeError, ValueError) as error:
        raise HTTPException(status_code=400, detail='Invalid analysis context. Analyze the resume again.') from error
    if not isinstance(context, dict) or not isinstance(context.get('resume_text'), str) or not context['resume_text'].strip():
        raise HTTPException(status_code=409, detail='Resume context is missing. Analyze the resume again.')
    code = context.get('code', '')
    if not isinstance(code, str) or (context.get('has_github') and not code.strip()):
        raise HTTPException(status_code=409, detail='Repository context is missing. Analyze the resume again.')
    if not isinstance(context.get('job_description', ''), str):
        raise HTTPException(status_code=400, detail='Invalid job description in analysis context.')
    if not isinstance(context.get('interview_metadata', {}), dict):
        raise HTTPException(status_code=400, detail='Invalid interview metadata in analysis context.')
    if len(context['resume_text']) > MAX_RESUME_CHARS or len(code) > MAX_CODE_CONTEXT_CHARS:
        raise HTTPException(status_code=413, detail='Analysis context exceeds the supported resume or repository text limit.')
    return context

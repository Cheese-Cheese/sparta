"""Check model response contracts without treating generated claims as facts."""
import json
import math
import re
from functools import wraps


class ModelOutputError(ValueError):
    """A model call failed or returned output that cannot be safely displayed."""


def model_call(function):
    """Keep provider errors out of successful results and public exception details."""
    @wraps(function)
    def checked(*args, **kwargs):
        try:
            return function(*args, **kwargs)
        except ModelOutputError:
            raise
        except Exception as error:
            raise ModelOutputError('The AI service could not complete this request. Please retry.') from error
    return checked


def completion_text(completion) -> str:
    choices = getattr(completion, 'choices', None)
    if not choices or getattr(choices[0], 'finish_reason', None) != 'stop':
        raise ModelOutputError('The AI response was incomplete. Please retry.')
    content = getattr(getattr(choices[0], 'message', None), 'content', None)
    if not isinstance(content, str) or not content.strip():
        raise ModelOutputError('The AI returned an empty response. Please retry.')
    return content.strip()


def json_object(text: str) -> dict:
    def reject_constant(value):
        raise ValueError('Non-finite JSON constant')

    try:
        value = json.loads(text, parse_constant=reject_constant)
    except (TypeError, ValueError) as error:
        raise ModelOutputError('The AI returned invalid JSON. Please retry.') from error
    if not isinstance(value, dict):
        raise ModelOutputError('The AI returned an invalid result. Please retry.')
    return value


def _require(condition):
    if not condition:
        raise ModelOutputError('The AI returned an invalid result. Please retry.')


def _text(value):
    _require(isinstance(value, str) and bool(value.strip()))


def _score(value):
    _require(type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 100)


def _strings(value):
    _require(isinstance(value, list))
    for item in value:
        _text(item)


def normalized(text: str) -> str:
    return ' '.join(text.split())


def validate_audit(text: str, code: str) -> dict:
    data = json_object(text)
    _score(data.get('combat_readiness_score'))
    _text(data.get('verdict'))
    metrics = data.get('ats_metrics')
    _require(isinstance(metrics, dict))
    for key in ('keyword_match_rate', 'quantification_rate'):
        _score(metrics.get(key))
    _strings(metrics.get('missing_critical_skills'))
    sections = data.get('sections')
    _require(isinstance(sections, dict))
    weights = {'experience': .40, 'skills': .30, 'formatting': .15, 'ats_compatibility': .15}
    for name in weights:
        section = sections.get(name)
        _require(isinstance(section, dict))
        _score(section.get('score'))
        _text(section.get('roast'))
    # Calculate this even when every section score is zero.
    data['combat_readiness_score'] = round(sum(weights[name] * sections[name]['score'] for name in weights))
    metadata = data.get('interview_metadata')
    _require(isinstance(metadata, dict))
    for key in ('target_seniority', 'ruthlessness_modifier'):
        _text(metadata.get(key))
    for key in ('phase1_domains', 'phase2_domains'):
        _strings(metadata.get(key))

    checks = data.get('evidence_checks')
    _require(isinstance(checks, list))
    # Validate quotes against the exact bounded sample, never the unseen repository.
    sources = {}
    matches = list(re.finditer(r'^--- FILE: (.+?) ---\n', code, re.MULTILINE))
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(code)
        sources.setdefault(match.group(1), []).append(normalized(code[match.end():end]))
    for check in checks:
        _require(isinstance(check, dict))
        for key in ('claim', 'source_file', 'excerpt'):
            _text(check.get(key))
        excerpt = normalized(check['excerpt'])
        _require(len(excerpt) >= 12 and any(excerpt in source for source in sources.get(check['source_file'], [])))
    # Source quotes support review. They do not establish semantic correctness.
    return data


def validate_report(text: str, evaluation_mode: str) -> dict:
    data = json_object(text)
    _score(data.get('overall_defense_score'))
    _text(data.get('defense_verdict'))
    mistakes = data.get('phase1_mistakes')
    corrections = data.get('phase2_corrections')
    _require(isinstance(mistakes, list) and isinstance(corrections, list))
    for mistake in mistakes:
        _require(isinstance(mistake, dict))
        _score(mistake.get('score'))
        _require(type(mistake.get('is_unanswered')) is bool)
        for key in ('question_label', 'feedback'):
            _text(mistake.get(key))
        _require(isinstance(mistake.get('failsafe_recommendation'), str))
        if mistake['is_unanswered']:
            mistake['score'] = 0
    for correction in corrections:
        _require(isinstance(correction, dict))
        _text(correction.get('category'))
        _text(correction.get('bullet'))
    scores = [item['score'] for item in mistakes if not item['is_unanswered']]
    data['overall_defense_score'] = int(sum(scores) / len(scores)) if scores else 0
    # The server chooses the mode from actual source text, not from model output.
    data['mode_evaluated'] = evaluation_mode
    return data

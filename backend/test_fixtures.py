"""Complete synthetic model output for offline response-contract tests."""


def audit_fixture():
    return {
        'combat_readiness_score': 80, 'verdict': 'Review source evidence',
        'ats_metrics': {'keyword_match_rate': 80, 'quantification_rate': 50, 'missing_critical_skills': []},
        'sections': {name: {'score': 80, 'roast': 'Synthetic test feedback.'}
                     for name in ('experience', 'skills', 'formatting', 'ats_compatibility')},
        'interview_metadata': {
            'target_seniority': 'Backend Engineer', 'phase1_domains': ['Order API', 'Python'],
            'phase2_domains': ['Redis'], 'ruthlessness_modifier': 'Ask for implementation details.',
        },
        'evidence_checks': [],
    }

/* eslint-disable @typescript-eslint/no-require-imports -- Offline tests compile the actual frontend modules. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function load(relativePath, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const context = { exports: {}, require, ...globals };
  vm.runInNewContext(compiled, context);
  return context.exports;
}

const report = {
  overall_defense_score: 60, mode_evaluated: 'RESUME-GROUNDED DEFENSE AUDIT', defense_verdict: 'Review answers',
  phase1_mistakes: [], phase2_corrections: [],
};

test('report requests preserve the exact transcript and caller context', async () => {
  let captured;
  const { requestInterviewReport } = load('../app/lib/interview-report.ts', { fetch: async (url, options) => {
    captured = { url, body: JSON.parse(options.body) };
    return { ok: true, json: async () => report };
  } });
  assert.deepEqual(await requestInterviewReport('Original resume', 'Candidate: I used SQL.', '{"code":"Source"}'), report);
  assert.equal(captured.url, '/api/rebuild');
  assert.deepEqual(captured.body, { resumeText: 'Original resume', spokenTranscript: 'Candidate: I used SQL.', context: '{"code":"Source"}' });
});

test('AI failure remains an actionable error instead of becoming a zero score', async () => {
  const { requestInterviewReport } = load('../app/lib/interview-report.ts', { fetch: async () => ({
    ok: false, json: async () => ({ error: 'The AI response was incomplete. Please retry.' }),
  }) });
  await assert.rejects(() => requestInterviewReport('Resume', 'Answer', '{}'), /incomplete.*retry/);
});

test('invalid successful reports never enter the report UI', async () => {
  for (const payload of [{}, { ...report, overall_defense_score: NaN }, { ...report, overall_defense_score: 101 },
    { ...report, phase1_mistakes: null }, { ...report, phase2_corrections: 'invented' },
    { ...report, phase1_mistakes: [{ score: 60, feedback: {} }] },
    { ...report, phase2_corrections: [{ category: 'Tools', bullet: {} }] }]) {
    const { requestInterviewReport } = load('../app/lib/interview-report.ts', { fetch: async () => ({
      ok: true, json: async () => payload,
    }) });
    await assert.rejects(() => requestInterviewReport('Resume', 'Answer', '{}'), /incomplete/);
  }
});

const EvidenceNotice = load('../app/components/EvidenceNotice.tsx').default;
function render(props) { return renderToStaticMarkup(React.createElement(EvidenceNotice, props)); }

test('coverage notice shows skipped files, truncation, and checked source quotes', () => {
  const html = render({ hasGithub: true,
    coverage: { status: 'partial', included_count: 1, total_files: 8,
      omitted: { directory_filter: 5, budget: 2 }, truncated_files: ['src/orders.py'] },
    checks: [{ claim: 'Sums inputs', source_file: 'src/orders.py', excerpt: 'return sum(items)' }],
  });
  for (const text of ['1 of 8', 'partial sample', 'directory filter: 5', 'budget: 2',
    'Files cut short: src/orders.py', 'Source quotes checked', 'return sum(items)', 'do not verify authorship']) {
    assert.ok(html.includes(text), text);
  }
});

test('old and resume-only snapshots never imply complete repository coverage', () => {
  assert.match(render({ hasGithub: true }), /coverage is unknown/);
  const html = render({ hasGithub: false });
  assert.match(html, /Resume claims only/);
  assert.match(html, /No checked source quotes/);
  assert.doesNotMatch(html, /All file text was included/);
});

/* eslint-disable @typescript-eslint/no-require-imports -- Node.js tests compile the real route in a controlled VM. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../app/api/interrogation/route.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

function route(post, backendUrl = 'https://backend.example') {
  const context = {
    exports: {}, process: { env: { NEXT_PUBLIC_BACKEND_URL: backendUrl } },
    require(name) {
      if (name === 'axios') return { __esModule: true, default: { post, isAxiosError: error => error.isAxiosError === true } };
      if (name === 'next/server') return { NextResponse: { json: (body, options = {}) => ({ body, status: options.status || 200 }) } };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  };
  vm.runInNewContext(compiled, context);
  return context.exports.POST;
}

test('forwards the complete audit context and history to the interview backend', async () => {
  const audit = {
    resume_text: 'Experience: built order APIs', code: '--- FILE: orders.py ---\ndef total(): return 1',
    has_github: true, repo_url: 'https://github.com/reader/orders', job_description: 'Build APIs with Redis',
    interview_metadata: { phase1_domains: ['Python'], target_seniority: 'Backend Engineer' },
  };
  const body = { message: 'My answer', history: [{ type: 'model', text: 'Explain order totals.' }], context: JSON.stringify(audit) };
  let captured;
  const post = route(async (url, payload) => { captured = { url, payload }; return { data: { response: 'Next question' } }; });
  const result = await post({ json: async () => body });
  assert.equal(captured.url, 'https://backend.example/chat');
  assert.equal(captured.payload.context, body.context);
  assert.deepEqual(captured.payload.history, body.history);
  assert.equal(captured.payload.message, body.message);
  assert.equal(result.body.response, 'Next question');
});

test('uses the deployed backend when no environment override exists', async () => {
  let target;
  const defaultPost = route(async url => { target = url; return { data: {} }; }, '');
  await defaultPost({ json: async () => ({}) });
  assert.equal(target, 'https://sparta-1l4n.onrender.com/chat');
});

test('keeps missing-context errors actionable instead of masking them as connection failures', async () => {
  const post = route(async () => { throw { isAxiosError: true, response: {
    status: 409, data: { detail: 'Repository context is missing. Analyze the resume again.' },
  } }; });
  const result = await post({ json: async () => ({}) });
  assert.equal(result.status, 409);
  assert.match(result.body.error, /Analyze the resume again/);
});

test('returns a gateway error when the backend is unreachable', async () => {
  const post = route(async () => { throw { isAxiosError: true }; });
  const result = await post({ json: async () => ({}) });
  assert.equal(result.status, 502);
  assert.equal(result.body.error, 'Failed to communicate with AI engine');
});

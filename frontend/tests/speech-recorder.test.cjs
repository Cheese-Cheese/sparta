/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-this-alias -- Node.js uses CommonJS here; fixtures expose mock instances for assertions. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../app/lib/speech-recorder.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

function fixture(options = {}) {
  const states = [], transcripts = [], errors = [], sent = [], timers = new Map();
  let recorder, socket, nextTimer = 0;
  const track = { stopped: false, onended: null, stop() { this.stopped = true; } };
  const stream = { getTracks: () => [track] };
  class Recorder {
    static isTypeSupported(type) { return type === (options.mime || 'audio/webm;codecs=opus'); }
    constructor(_stream, config) {
      if (options.constructorError) throw new DOMException('format unavailable', 'NotSupportedError');
      this.config = config;
      this.state = 'inactive';
      recorder = this;
    }
    start(timeslice) { this.state = 'recording'; this.timeslice = timeslice; }
    stop() {
      assert.equal(this.state, 'recording');
      this.state = 'inactive';
      this.ondataavailable?.({ data: { size: 12, finalChunk: true } });
      this.onstop?.();
    }
  }
  class Socket {
    static OPEN = 1;
    constructor() { socket = this; this.readyState = 0; }
    send(data) { sent.push(data); }
    close() { this.readyState = 3; }
    open() { this.readyState = 1; this.onopen?.(); }
    message(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
  }
  const context = {
    exports: {}, DOMException, AbortController, MediaRecorder: Recorder, WebSocket: Socket,
    navigator: { mediaDevices: { getUserMedia: options.getUserMedia || (async () => {
      if (options.permissionError) throw new DOMException('denied', 'NotAllowedError');
      return stream;
    }) } },
    fetch: async () => ({ ok: !options.keyError, json: async () => options.keyError ? { error: 'Deepgram API key is not configured' } : { key: 'test-key' } }),
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  vm.runInNewContext(compiled, context);
  const session = new context.exports.SpeechRecorder({
    onState: state => states.push(state),
    onTranscript: text => transcripts.push(text),
    onError: error => errors.push(error),
  });
  return {
    session, states, transcripts, errors, sent, timers, track, stream,
    get recorder() { return recorder; }, get socket() { return socket; },
  };
}

test('uses MP4 when the browser cannot record WebM', async () => {
  const f = fixture({ mime: 'audio/mp4' });
  await f.session.start(); f.socket.open();
  assert.equal(f.recorder.config.mimeType, 'audio/mp4');
  assert.equal(f.recorder.timeslice, 250);
  assert.equal(f.session.status, 'listening');
  f.session.dispose();
  assert.equal(f.track.stopped, true);
  assert.equal(f.timers.size, 0);
});

test('uses the browser default when no preferred format is supported', async () => {
  const f = fixture({ mime: 'browser-default' });
  await f.session.start(); f.socket.open();
  assert.equal(f.recorder.config, undefined);
  f.session.dispose();
});

test('reports blocked microphone permission', async () => {
  const f = fixture({ permissionError: true });
  await f.session.start();
  assert.match(f.errors.at(-1), /Microphone access was blocked/);
  assert.equal(f.session.status, 'idle');
  assert.equal(f.socket, undefined);
});

test('reports recorder format failures and releases the microphone', async () => {
  const f = fixture({ constructorError: true });
  await f.session.start();
  assert.match(f.errors.at(-1), /audio format/);
  assert.equal(f.track.stopped, true);
});

test('shows the key route error without opening a speech connection', async () => {
  const f = fixture({ keyError: true });
  await f.session.start();
  assert.equal(f.errors.at(-1), 'Deepgram API key is not configured');
  assert.equal(f.track.stopped, true);
  assert.equal(f.socket, undefined);
});

test('sends the last audio chunk before CloseStream and waits for final words', async () => {
  const f = fixture();
  await f.session.start(); f.socket.open();
  f.socket.message({ is_final: false, channel: { alternatives: [{ transcript: 'my answer' }] } });
  const answer = f.session.stop();
  assert.equal(f.session.status, 'finishing');
  assert.equal(f.sent[0].finalChunk, true);
  assert.equal(JSON.parse(f.sent[1]).type, 'CloseStream');
  assert.equal(f.track.stopped, true);
  f.socket.message({ is_final: true, channel: { alternatives: [{ transcript: 'my answer includes final words' }] } });
  f.socket.message({ type: 'Metadata' });
  assert.equal(await answer, 'my answer includes final words');
  assert.equal(f.session.status, 'idle');
  assert.equal(f.timers.size, 0);
});

test('combines final segments without repeating their interim text', async () => {
  const f = fixture();
  await f.session.start(); f.socket.open();
  for (const [text, final] of [['first', false], ['first sentence.', true], ['second', false], ['second sentence.', true]]) {
    f.socket.message({ is_final: final, channel: { alternatives: [{ transcript: text }] } });
  }
  assert.equal(f.transcripts.at(-1), 'first sentence. second sentence.');
  f.session.dispose();
});

test('unexpected socket closure reports an error and stops the microphone', async () => {
  const f = fixture();
  await f.session.start(); f.socket.open();
  f.socket.onclose({ code: 1008 });
  assert.match(f.errors.at(-1), /code 1008/);
  assert.equal(f.track.stopped, true);
  assert.equal(f.session.status, 'idle');
});

test('connection timeout returns the controls to idle', async () => {
  const f = fixture();
  await f.session.start();
  [...f.timers.values()].find(timer => timer.delay === 15000).fn();
  assert.match(f.errors.at(-1), /did not connect/);
  assert.equal(f.track.stopped, true);
  assert.equal(f.session.status, 'idle');
});

test('final transcript timeout resolves without submitting an incomplete answer', async () => {
  const f = fixture();
  await f.session.start(); f.socket.open();
  const answer = f.session.stop();
  [...f.timers.values()].find(timer => timer.delay === 5000).fn();
  assert.equal(await answer, '');
  assert.match(f.errors.at(-1), /too long/);
  assert.equal(f.timers.size, 0);
});

test('empty recording shows a useful input-volume error', async () => {
  const f = fixture();
  await f.session.start(); f.socket.open();
  const answer = f.session.stop(); f.socket.message({ type: 'Metadata' });
  assert.equal(await answer, '');
  assert.match(f.errors.at(-1), /No speech was detected/);
});

test('closing the view during a permission prompt stops a late microphone stream', async () => {
  let resolveStream;
  const f = fixture({ getUserMedia: () => new Promise(resolve => { resolveStream = resolve; }) });
  const starting = f.session.start();
  f.session.dispose(); resolveStream(f.stream); await starting;
  assert.equal(f.track.stopped, true);
  assert.equal(f.socket, undefined);
});

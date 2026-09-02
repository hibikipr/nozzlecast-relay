const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSseChunk, NtfyWatcher } = require('../src/ntfyWatcher');

test('parseSseChunk extracts a single complete message', () => {
  const chunk = 'data: {"event":"message","title":"Print Started","message":"Vic H2C: Started"}\n\n';
  const { messages, remainder } = parseSseChunk(chunk);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].title, 'Print Started');
  assert.equal(remainder, '');
});

test('parseSseChunk extracts multiple messages from one chunk', () => {
  const chunk =
    'data: {"event":"open"}\n\n' +
    'data: {"event":"message","title":"Print Started","message":"Vic H2C: Started"}\n\n';
  const { messages } = parseSseChunk(chunk);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].event, 'open');
  assert.equal(messages[1].event, 'message');
});

test('parseSseChunk carries an incomplete trailing message into remainder', () => {
  const chunk = 'data: {"event":"message","title":"Print S';
  const { messages, remainder } = parseSseChunk(chunk);
  assert.equal(messages.length, 0);
  assert.equal(remainder, chunk);
});

test('parseSseChunk combines a remainder with the next chunk correctly', () => {
  const first = parseSseChunk('data: {"event":"message","tit');
  const second = parseSseChunk(first.remainder + 'le":"Print Started"}\n\n');
  assert.equal(second.messages.length, 1);
  assert.equal(second.messages[0].title, 'Print Started');
});

test('parseSseChunk skips malformed JSON lines without throwing', () => {
  const chunk = 'data: {not valid json}\n\ndata: {"event":"message","title":"OK"}\n\n';
  const { messages } = parseSseChunk(chunk);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].title, 'OK');
});

function fakeStreamResponse(chunks) {
  return {
    ok: true,
    body: {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) {
          yield Buffer.from(chunk);
        }
      },
    },
  };
}

test('NtfyWatcher delivers parsed "message" events to onMessage', async () => {
  const received = [];
  const chunk = 'data: {"event":"message","title":"Print Started","message":"Vic H2C: Started"}\n\n';
  let callCount = 0;
  const fetchImpl = async () => {
    callCount += 1;
    if (callCount === 1) return fakeStreamResponse([chunk]);
    return new Promise(() => {}); // second connection just hangs, so the test can finish
  };

  const watcher = new NtfyWatcher({
    server: 'https://ntfy.townsville.cc',
    topic: 'townsville-3dprinter',
    authToken: 'tk_test',
    onMessage: (msg) => received.push(msg),
    fetchImpl,
    backoff: { minMs: 5, maxMs: 10 },
  });

  watcher.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
  watcher.stop();

  assert.equal(received.length, 1);
  assert.equal(received[0].title, 'Print Started');
});

test('NtfyWatcher ignores non-"message" events', async () => {
  const received = [];
  const chunk = 'data: {"event":"open"}\n\ndata: {"event":"keepalive"}\n\n';
  const fetchImpl = async () => fakeStreamResponse([chunk]);

  const watcher = new NtfyWatcher({
    server: 'https://ntfy.townsville.cc',
    topic: 'townsville-3dprinter',
    authToken: 'tk_test',
    onMessage: (msg) => received.push(msg),
    fetchImpl,
    backoff: { minMs: 5, maxMs: 10 },
  });

  watcher.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
  watcher.stop();

  assert.equal(received.length, 0);
});

test('NtfyWatcher reconnects after the stream ends', async () => {
  let callCount = 0;
  const fetchImpl = async () => {
    callCount += 1;
    if (callCount <= 2) return fakeStreamResponse([]); // ends immediately each time
    return new Promise(() => {});
  };

  const watcher = new NtfyWatcher({
    server: 'https://ntfy.townsville.cc',
    topic: 'townsville-3dprinter',
    authToken: 'tk_test',
    onMessage: () => {},
    fetchImpl,
    backoff: { minMs: 5, maxMs: 10 },
  });

  watcher.start();
  await new Promise((resolve) => setTimeout(resolve, 100));
  watcher.stop();

  assert.ok(callCount >= 2, `expected at least 2 connection attempts, got ${callCount}`);
});

test('NtfyWatcher sends the auth token as a Bearer header', async () => {
  let capturedUrl = null;
  let capturedHeaders = null;
  const fetchImpl = async (url, options) => {
    capturedUrl = url;
    capturedHeaders = options.headers;
    return new Promise(() => {});
  };

  const watcher = new NtfyWatcher({
    server: 'https://ntfy.townsville.cc',
    topic: 'townsville-3dprinter',
    authToken: 'tk_test',
    onMessage: () => {},
    fetchImpl,
    backoff: { minMs: 5, maxMs: 10 },
  });

  watcher.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  watcher.stop();

  assert.equal(capturedUrl, 'https://ntfy.townsville.cc/townsville-3dprinter/sse');
  assert.equal(capturedHeaders.Authorization, 'Bearer tk_test');
});

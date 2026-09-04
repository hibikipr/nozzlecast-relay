const test = require('node:test');
const assert = require('node:assert/strict');
const { BambuddyClient } = require('../src/bambuddyClient');

function fakeFetchReturning(responsesByPath) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const path = new URL(url).pathname;
    const entry = responsesByPath[path];
    if (!entry) throw new Error(`unexpected path in test: ${path}`);
    return {
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      json: async () => entry.body,
    };
  };
  return { fetchImpl, calls };
}

test('printers() GETs /api/v1/printers/ with bearer auth and returns the parsed body', async () => {
  const { fetchImpl, calls } = fakeFetchReturning({
    '/api/v1/printers/': { status: 200, body: [{ id: 1, name: 'Sam P1S' }] },
  });
  const client = new BambuddyClient({ baseUrl: 'https://bambuddy.example.com', apiKey: 'bb_test', fetchImpl });

  const result = await client.printers();

  assert.deepEqual(result, [{ id: 1, name: 'Sam P1S' }]);
  assert.equal(calls[0].url, 'https://bambuddy.example.com/api/v1/printers/');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer bb_test');
});

test('status(id) GETs /api/v1/printers/{id}/status', async () => {
  const { fetchImpl, calls } = fakeFetchReturning({
    '/api/v1/printers/1/status': { status: 200, body: { progress: 42 } },
  });
  const client = new BambuddyClient({ baseUrl: 'https://bambuddy.example.com', apiKey: 'bb_test', fetchImpl });

  const result = await client.status(1);

  assert.deepEqual(result, { progress: 42 });
  assert.equal(calls[0].url, 'https://bambuddy.example.com/api/v1/printers/1/status');
});

test('a non-2xx response throws instead of returning a falsy/empty result', async () => {
  const { fetchImpl } = fakeFetchReturning({
    '/api/v1/printers/1/status': { status: 404, body: { error: 'not found' } },
  });
  const client = new BambuddyClient({ baseUrl: 'https://bambuddy.example.com', apiKey: 'bb_test', fetchImpl });

  await assert.rejects(client.status(1), /status 404/);
});

test('mintCameraStreamToken() POSTs to the stream-token endpoint with bearer auth and returns the token', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ token: 'streamtok123' }) };
  };
  const client = new BambuddyClient({ baseUrl: 'https://bambuddy.example.com', apiKey: 'bb_test', fetchImpl });

  const token = await client.mintCameraStreamToken();

  assert.equal(token, 'streamtok123');
  assert.equal(calls[0].url, 'https://bambuddy.example.com/api/v1/printers/camera/stream-token');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer bb_test');
});

test('mintCameraStreamToken() throws on a non-2xx response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });
  const client = new BambuddyClient({ baseUrl: 'https://bambuddy.example.com', apiKey: 'bb_test', fetchImpl });

  await assert.rejects(client.mintCameraStreamToken(), /status 500/);
});

test('cover(id, token) GETs the cover endpoint with the token as a query param and returns raw bytes', async () => {
  const calls = [];
  const fakeBytes = Buffer.from([1, 2, 3, 4]);
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, arrayBuffer: async () => fakeBytes.buffer.slice(fakeBytes.byteOffset, fakeBytes.byteOffset + fakeBytes.byteLength) };
  };
  const client = new BambuddyClient({ baseUrl: 'https://bambuddy.example.com', apiKey: 'bb_test', fetchImpl });

  const result = await client.cover(2, 'streamtok123');

  assert.ok(Buffer.isBuffer(result));
  assert.deepEqual(result, fakeBytes);
  assert.equal(calls[0], 'https://bambuddy.example.com/api/v1/printers/2/cover?token=streamtok123');
});

test('cameraSnapshot(id, token) GETs the snapshot endpoint with the token as a query param', async () => {
  const calls = [];
  const fakeBytes = Buffer.from([5, 6, 7]);
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, arrayBuffer: async () => fakeBytes.buffer.slice(fakeBytes.byteOffset, fakeBytes.byteOffset + fakeBytes.byteLength) };
  };
  const client = new BambuddyClient({ baseUrl: 'https://bambuddy.example.com', apiKey: 'bb_test', fetchImpl });

  const result = await client.cameraSnapshot(2, 'streamtok123');

  assert.deepEqual(result, fakeBytes);
  assert.equal(calls[0], 'https://bambuddy.example.com/api/v1/printers/2/camera/snapshot?token=streamtok123');
});

test('cover() throws on a non-2xx response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404 });
  const client = new BambuddyClient({ baseUrl: 'https://bambuddy.example.com', apiKey: 'bb_test', fetchImpl });

  await assert.rejects(client.cover(2, 'badtoken'), /status 404/);
});

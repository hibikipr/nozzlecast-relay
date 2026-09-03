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
  const client = new BambuddyClient({ baseUrl: 'https://bambuddy.townsville.cc', apiKey: 'bb_test', fetchImpl });

  const result = await client.printers();

  assert.deepEqual(result, [{ id: 1, name: 'Sam P1S' }]);
  assert.equal(calls[0].url, 'https://bambuddy.townsville.cc/api/v1/printers/');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer bb_test');
});

test('status(id) GETs /api/v1/printers/{id}/status', async () => {
  const { fetchImpl, calls } = fakeFetchReturning({
    '/api/v1/printers/1/status': { status: 200, body: { progress: 42 } },
  });
  const client = new BambuddyClient({ baseUrl: 'https://bambuddy.townsville.cc', apiKey: 'bb_test', fetchImpl });

  const result = await client.status(1);

  assert.deepEqual(result, { progress: 42 });
  assert.equal(calls[0].url, 'https://bambuddy.townsville.cc/api/v1/printers/1/status');
});

test('a non-2xx response throws instead of returning a falsy/empty result', async () => {
  const { fetchImpl } = fakeFetchReturning({
    '/api/v1/printers/1/status': { status: 404, body: { error: 'not found' } },
  });
  const client = new BambuddyClient({ baseUrl: 'https://bambuddy.townsville.cc', apiKey: 'bb_test', fetchImpl });

  await assert.rejects(client.status(1), /status 404/);
});

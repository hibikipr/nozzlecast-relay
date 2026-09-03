const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ActivityTokenStore } = require('../src/activityTokenStore');

async function tempFilePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nozzlecast-relay-test-'));
  return path.join(dir, 'activity-tokens.json');
}

test('load() on a missing file starts with an empty list', async () => {
  const store = new ActivityTokenStore(await tempFilePath());
  await store.load();
  assert.deepEqual(store.list(), []);
});

test('get() returns undefined for an unknown printerID', async () => {
  const store = new ActivityTokenStore(await tempFilePath());
  await store.load();
  assert.equal(store.get('samp1s'), undefined);
});

test('startPrint() records printerName/startedAt with no token yet', async () => {
  const store = new ActivityTokenStore(await tempFilePath());
  await store.load();
  await store.startPrint({ printerID: 'samp1s', printerName: 'Sam P1S', startedAt: '2026-09-02T18:00:00.000Z' });

  const entry = store.get('samp1s');
  assert.equal(entry.printerName, 'Sam P1S');
  assert.equal(entry.startedAt, '2026-09-02T18:00:00.000Z');
  assert.equal(entry.token, null);
});

test('registerToken() after startPrint() preserves the tracked startedAt/printerName', async () => {
  const store = new ActivityTokenStore(await tempFilePath());
  await store.load();
  await store.startPrint({ printerID: 'samp1s', printerName: 'Sam P1S', startedAt: '2026-09-02T18:00:00.000Z' });
  await store.registerToken({ printerID: 'samp1s', token: 'abc123', environment: 'sandbox' });

  const entry = store.get('samp1s');
  assert.equal(entry.token, 'abc123');
  assert.equal(entry.environment, 'sandbox');
  assert.equal(entry.printerName, 'Sam P1S');
  assert.equal(entry.startedAt, '2026-09-02T18:00:00.000Z');
  assert.ok(entry.registeredAt);
});

test('registerToken() with no prior startPrint() creates a bare entry', async () => {
  const store = new ActivityTokenStore(await tempFilePath());
  await store.load();
  await store.registerToken({ printerID: 'samp1s', token: 'abc123', environment: 'sandbox' });

  const entry = store.get('samp1s');
  assert.equal(entry.token, 'abc123');
  assert.equal(entry.printerName, null);
  assert.equal(entry.startedAt, null);
});

test('startPrint() on a new print replaces the previous token for that printer', async () => {
  const store = new ActivityTokenStore(await tempFilePath());
  await store.load();
  await store.startPrint({ printerID: 'samp1s', printerName: 'Sam P1S', startedAt: '2026-09-02T18:00:00.000Z' });
  await store.registerToken({ printerID: 'samp1s', token: 'old-token', environment: 'sandbox' });

  await store.startPrint({ printerID: 'samp1s', printerName: 'Sam P1S', startedAt: '2026-09-02T20:00:00.000Z' });

  const entry = store.get('samp1s');
  assert.equal(entry.token, null);
  assert.equal(entry.startedAt, '2026-09-02T20:00:00.000Z');
});

test('registerToken() for a second print replaces the first print\'s token entirely', async () => {
  const store = new ActivityTokenStore(await tempFilePath());
  await store.load();
  await store.registerToken({ printerID: 'samp1s', token: 'old-token', environment: 'sandbox' });
  await store.registerToken({ printerID: 'samp1s', token: 'new-token', environment: 'production' });

  const entry = store.get('samp1s');
  assert.equal(entry.token, 'new-token');
  assert.equal(entry.environment, 'production');
});

test('clearToken() removes the token but keeps printerName/startedAt', async () => {
  const store = new ActivityTokenStore(await tempFilePath());
  await store.load();
  await store.startPrint({ printerID: 'samp1s', printerName: 'Sam P1S', startedAt: '2026-09-02T18:00:00.000Z' });
  await store.registerToken({ printerID: 'samp1s', token: 'abc123', environment: 'sandbox' });
  await store.clearToken('samp1s');

  const entry = store.get('samp1s');
  assert.equal(entry.token, null);
  assert.equal(entry.printerName, 'Sam P1S');
  assert.equal(entry.startedAt, '2026-09-02T18:00:00.000Z');
});

test('clearToken() on an unknown printerID is a no-op', async () => {
  const store = new ActivityTokenStore(await tempFilePath());
  await store.load();
  await assert.doesNotReject(store.clearToken('nope'));
  assert.equal(store.get('nope'), undefined);
});

test('load() on a file containing invalid JSON logs a warning and starts with an empty list', async () => {
  const filePath = await tempFilePath();
  await fs.writeFile(filePath, '{ this is not valid json ]', 'utf8');
  const store = new ActivityTokenStore(filePath);
  await assert.doesNotReject(store.load());
  assert.deepEqual(store.list(), []);
});

test('load() reads back entries written by a previous store instance', async () => {
  const filePath = await tempFilePath();
  const first = new ActivityTokenStore(filePath);
  await first.load();
  await first.registerToken({ printerID: 'samp1s', token: 'abc123', environment: 'sandbox' });

  const second = new ActivityTokenStore(filePath);
  await second.load();
  assert.equal(second.get('samp1s').token, 'abc123');
});

test('two different printers are tracked independently', async () => {
  const store = new ActivityTokenStore(await tempFilePath());
  await store.load();
  await store.registerToken({ printerID: 'samp1s', token: 'token-a', environment: 'sandbox' });
  await store.registerToken({ printerID: 'vich2c', token: 'token-b', environment: 'production' });

  assert.equal(store.get('samp1s').token, 'token-a');
  assert.equal(store.get('vich2c').token, 'token-b');
  assert.equal(store.list().length, 2);
});

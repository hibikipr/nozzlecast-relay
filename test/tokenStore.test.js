const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TokenStore } = require('../src/tokenStore');

async function tempFilePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nozzlecast-relay-test-'));
  return path.join(dir, 'tokens.json');
}

test('load() on a missing file starts with an empty list', async () => {
  const filePath = await tempFilePath();
  const store = new TokenStore(filePath);
  await store.load();
  assert.deepEqual(store.list(), []);
});

test('upsert() adds a token and persists it to disk', async () => {
  const filePath = await tempFilePath();
  const store = new TokenStore(filePath);
  await store.load();
  await store.upsert({ token: 'abc123', environment: 'sandbox' });

  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].token, 'abc123');
  assert.equal(store.list()[0].environment, 'sandbox');
  assert.ok(store.list()[0].registeredAt);

  const onDisk = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0].token, 'abc123');
});

test('upsert() with an existing token updates it in place instead of duplicating', async () => {
  const filePath = await tempFilePath();
  const store = new TokenStore(filePath);
  await store.load();
  await store.upsert({ token: 'abc123', environment: 'sandbox' });
  await store.upsert({ token: 'abc123', environment: 'production' });

  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].environment, 'production');
});

test('remove() deletes a token and persists the change', async () => {
  const filePath = await tempFilePath();
  const store = new TokenStore(filePath);
  await store.load();
  await store.upsert({ token: 'abc123', environment: 'sandbox' });
  await store.upsert({ token: 'def456', environment: 'production' });
  await store.remove('abc123');

  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].token, 'def456');

  const onDisk = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.equal(onDisk.length, 1);
});

test('load() reads back tokens written by a previous store instance', async () => {
  const filePath = await tempFilePath();
  const first = new TokenStore(filePath);
  await first.load();
  await first.upsert({ token: 'abc123', environment: 'sandbox' });

  const second = new TokenStore(filePath);
  await second.load();
  assert.equal(second.list().length, 1);
  assert.equal(second.list()[0].token, 'abc123');
});

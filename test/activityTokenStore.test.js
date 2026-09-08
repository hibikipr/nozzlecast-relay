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
  assert.deepEqual(entry.tokens, []);
});

test('registerToken() after startPrint() preserves the tracked startedAt/printerName', async () => {
  const store = new ActivityTokenStore(await tempFilePath());
  await store.load();
  await store.startPrint({ printerID: 'samp1s', printerName: 'Sam P1S', startedAt: '2026-09-02T18:00:00.000Z' });
  await store.registerToken({ printerID: 'samp1s', token: 'abc123', environment: 'sandbox' });

  const entry = store.get('samp1s');
  assert.equal(entry.printerName, 'Sam P1S');
  assert.equal(entry.startedAt, '2026-09-02T18:00:00.000Z');
  assert.deepEqual(store.tokensFor('samp1s').map((t) => t.token), ['abc123']);
  assert.equal(store.tokensFor('samp1s')[0].environment, 'sandbox');
  assert.ok(store.tokensFor('samp1s')[0].registeredAt);
});

test('registerToken() with no prior startPrint() creates a bare entry', async () => {
  const store = new ActivityTokenStore(await tempFilePath());
  await store.load();
  await store.registerToken({ printerID: 'samp1s', token: 'abc123', environment: 'sandbox' });

  const entry = store.get('samp1s');
  assert.equal(entry.printerName, null);
  assert.equal(entry.startedAt, null);
  assert.deepEqual(store.tokensFor('samp1s').map((t) => t.token), ['abc123']);
});

test('startPrint() on a new print drops every previous token for that printer', async () => {
  const store = new ActivityTokenStore(await tempFilePath());
  await store.load();
  await store.startPrint({ printerID: 'samp1s', printerName: 'Sam P1S', startedAt: '2026-09-02T18:00:00.000Z' });
  await store.registerToken({ printerID: 'samp1s', token: 'old-token', environment: 'sandbox' });

  await store.startPrint({ printerID: 'samp1s', printerName: 'Sam P1S', startedAt: '2026-09-02T20:00:00.000Z' });

  const entry = store.get('samp1s');
  assert.deepEqual(entry.tokens, []);
  assert.equal(entry.startedAt, '2026-09-02T20:00:00.000Z');
});

// Superseded: this used to assert that a second registration REPLACED the first, which is the
// defect itself -- the relay cannot tell "the same device re-registering for a new print" from
// "a second device joining the same print", and only startPrint() knows a new print began. So a
// second distinct token is now additive, and startPrint() is what clears the slate (above).
test('registerToken() with a different token adds a device rather than replacing one', async () => {
  const store = new ActivityTokenStore(await tempFilePath());
  await store.load();
  await store.registerToken({ printerID: 'samp1s', token: 'old-token', environment: 'sandbox' });
  await store.registerToken({ printerID: 'samp1s', token: 'new-token', environment: 'production' });

  assert.deepEqual(
    store.tokensFor('samp1s').map((t) => t.token).sort(),
    ['new-token', 'old-token'],
  );
});

test('removeToken() removes the token but keeps printerName/startedAt', async () => {
  const store = new ActivityTokenStore(await tempFilePath());
  await store.load();
  await store.startPrint({ printerID: 'samp1s', printerName: 'Sam P1S', startedAt: '2026-09-02T18:00:00.000Z' });
  await store.registerToken({ printerID: 'samp1s', token: 'abc123', environment: 'sandbox' });
  await store.removeToken('samp1s', 'abc123');

  const entry = store.get('samp1s');
  assert.deepEqual(entry.tokens, []);
  assert.equal(entry.printerName, 'Sam P1S');
  assert.equal(entry.startedAt, '2026-09-02T18:00:00.000Z');
});

test('removeToken() on an unknown printerID is a no-op', async () => {
  const store = new ActivityTokenStore(await tempFilePath());
  await store.load();
  await assert.doesNotReject(store.removeToken('nope', 'whatever'));
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
  assert.deepEqual(second.tokensFor('samp1s').map((t) => t.token), ['abc123']);
});

test('startPrint() records coverImage as null (nothing fetched yet for this print)', async () => {
  const store = new ActivityTokenStore(await tempFilePath());
  await store.load();
  await store.startPrint({ printerID: 'samp1s', printerName: 'Sam P1S', startedAt: '2026-09-02T18:00:00.000Z' });

  assert.equal(store.get('samp1s').coverImage, null);
});

test('setCoverImage() caches the base64 image for that printer', async () => {
  const store = new ActivityTokenStore(await tempFilePath());
  await store.load();
  await store.startPrint({ printerID: 'samp1s', printerName: 'Sam P1S', startedAt: '2026-09-02T18:00:00.000Z' });
  await store.setCoverImage('samp1s', 'Zm9v');

  assert.equal(store.get('samp1s').coverImage, 'Zm9v');
});

test('setCoverImage() on an untracked printerID is a no-op', async () => {
  const store = new ActivityTokenStore(await tempFilePath());
  await store.load();
  await assert.doesNotReject(store.setCoverImage('nope', 'Zm9v'));
  assert.equal(store.get('nope'), undefined);
});

test('registerToken() preserves a coverImage already cached by setCoverImage()', async () => {
  const store = new ActivityTokenStore(await tempFilePath());
  await store.load();
  await store.startPrint({ printerID: 'samp1s', printerName: 'Sam P1S', startedAt: '2026-09-02T18:00:00.000Z' });
  await store.setCoverImage('samp1s', 'Zm9v');
  await store.registerToken({ printerID: 'samp1s', token: 'abc123', environment: 'sandbox' });

  assert.equal(store.get('samp1s').coverImage, 'Zm9v');
});

test('startPrint() on a new print clears the previous print\'s cached coverImage', async () => {
  const store = new ActivityTokenStore(await tempFilePath());
  await store.load();
  await store.startPrint({ printerID: 'samp1s', printerName: 'Sam P1S', startedAt: '2026-09-02T18:00:00.000Z' });
  await store.setCoverImage('samp1s', 'Zm9v');

  await store.startPrint({ printerID: 'samp1s', printerName: 'Sam P1S', startedAt: '2026-09-02T20:00:00.000Z' });

  assert.equal(store.get('samp1s').coverImage, null);
});

test('two different printers are tracked independently', async () => {
  const store = new ActivityTokenStore(await tempFilePath());
  await store.load();
  await store.registerToken({ printerID: 'samp1s', token: 'token-a', environment: 'sandbox' });
  await store.registerToken({ printerID: 'vich2c', token: 'token-b', environment: 'production' });

  assert.deepEqual(store.tokensFor('samp1s').map((t) => t.token), ['token-a']);
  assert.deepEqual(store.tokensFor('vich2c').map((t) => t.token), ['token-b']);
  assert.equal(store.list().length, 2);
});

// --- Multiple devices watching the same print (2026-09-08) ---
//
// Confirmed live: a phone registered for "vich2c" at 08:15:52, an iPad registered for the same
// printer at 08:48:54, and the second registration silently evicted the first. Updates kept
// flowing with APNs 200s, but only to the iPad -- the phone's Live Activity froze at whatever it
// last received, with nothing relay-visible marking the takeover.

test('registerToken() keeps tokens from two different devices for the same printer', async () => {
  const store = new ActivityTokenStore(await tempFilePath());
  await store.load();
  await store.startPrint({ printerID: 'vich2c', printerName: 'Vic H2C', startedAt: '2026-09-08T12:15:52.000Z' });
  await store.registerToken({ printerID: 'vich2c', token: 'phone-token', environment: 'production' });
  await store.registerToken({ printerID: 'vich2c', token: 'ipad-token', environment: 'production' });

  assert.deepEqual(
    store.tokensFor('vich2c').map((t) => t.token).sort(),
    ['ipad-token', 'phone-token'],
  );
});

test('registerToken() re-registering the same device does not duplicate it', async () => {
  const store = new ActivityTokenStore(await tempFilePath());
  await store.load();
  await store.registerToken({ printerID: 'vich2c', token: 'phone-token', environment: 'production' });
  await store.registerToken({ printerID: 'vich2c', token: 'phone-token', environment: 'production' });

  assert.equal(store.tokensFor('vich2c').length, 1);
});

test('removeToken() drops only the dead device, leaving the others live', async () => {
  const store = new ActivityTokenStore(await tempFilePath());
  await store.load();
  await store.startPrint({ printerID: 'vich2c', printerName: 'Vic H2C', startedAt: '2026-09-08T12:15:52.000Z' });
  await store.registerToken({ printerID: 'vich2c', token: 'phone-token', environment: 'production' });
  await store.registerToken({ printerID: 'vich2c', token: 'ipad-token', environment: 'production' });
  await store.removeToken('vich2c', 'ipad-token');

  assert.deepEqual(store.tokensFor('vich2c').map((t) => t.token), ['phone-token']);
  assert.equal(store.get('vich2c').startedAt, '2026-09-08T12:15:52.000Z');
});

test('startPrint() clears every device token, since a new print means new activities', async () => {
  const store = new ActivityTokenStore(await tempFilePath());
  await store.load();
  await store.registerToken({ printerID: 'vich2c', token: 'phone-token', environment: 'production' });
  await store.registerToken({ printerID: 'vich2c', token: 'ipad-token', environment: 'production' });
  await store.startPrint({ printerID: 'vich2c', printerName: 'Vic H2C', startedAt: '2026-09-08T13:00:00.000Z' });

  assert.deepEqual(store.tokensFor('vich2c'), []);
});

test('tokensFor() is empty for a printer that has never registered', async () => {
  const store = new ActivityTokenStore(await tempFilePath());
  await store.load();
  assert.deepEqual(store.tokensFor('nobody'), []);
});

test('load() migrates a single-token entry written by the previous schema', async () => {
  const filePath = await tempFilePath();
  await fs.writeFile(filePath, JSON.stringify([{
    printerID: 'vich2c',
    printerName: 'Vic H2C',
    startedAt: '2026-09-08T12:15:52.000Z',
    coverImage: 'aGVsbG8=',
    token: 'legacy-token',
    environment: 'production',
    registeredAt: '2026-09-08T12:15:52.000Z',
  }]));

  const store = new ActivityTokenStore(filePath);
  await store.load();

  assert.deepEqual(store.tokensFor('vich2c').map((t) => t.token), ['legacy-token']);
  assert.equal(store.get('vich2c').startedAt, '2026-09-08T12:15:52.000Z');
  assert.equal(store.get('vich2c').coverImage, 'aGVsbG8=');
});

test('load() migrates a legacy entry whose token was already cleared', async () => {
  const filePath = await tempFilePath();
  await fs.writeFile(filePath, JSON.stringify([{
    printerID: 'vich2c', printerName: 'Vic H2C', startedAt: null,
    coverImage: null, token: null, environment: null, registeredAt: null,
  }]));

  const store = new ActivityTokenStore(filePath);
  await store.load();

  assert.deepEqual(store.tokensFor('vich2c'), []);
});

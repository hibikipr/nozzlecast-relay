const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ActivityTokenStore } = require('../src/activityTokenStore');
const { resolveCoverImage, settleWithin, TIMED_OUT, MAX_COVER_IMAGE_ATTEMPTS } = require('../src/coverImageCache');

async function storeWithPrint() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nozzlecast-relay-test-'));
  const store = new ActivityTokenStore(path.join(dir, 'activity-tokens.json'));
  await store.load();
  await store.startPrint({ printerID: 'p', printerName: 'P', startedAt: '2026-01-01T00:00:00.000Z' });
  return store;
}

function countingFetch(result) {
  const fetchCover = async () => {
    fetchCover.calls += 1;
    if (result instanceof Error) throw result;
    return result;
  };
  fetchCover.calls = 0;
  return fetchCover;
}

test('a cover that keeps 404ing is fetched at most MAX_COVER_IMAGE_ATTEMPTS times per print', async () => {
  const store = await storeWithPrint();
  const fetchCover = countingFetch(new Error('Bambuddy request to /api/v1/printers/1/cover failed with status 404'));

  for (let update = 0; update < 10; update += 1) {
    assert.equal(await resolveCoverImage({ activityTokenStore: store, printerID: 'p', name: 'P', fetchCover }), null);
  }

  assert.equal(fetchCover.calls, MAX_COVER_IMAGE_ATTEMPTS);
});

test('a render over the byte budget counts as a failed attempt too', async () => {
  const store = await storeWithPrint();
  const fetchCover = countingFetch(null);

  for (let update = 0; update < 5; update += 1) {
    await resolveCoverImage({ activityTokenStore: store, printerID: 'p', name: 'P', fetchCover });
  }

  assert.equal(fetchCover.calls, MAX_COVER_IMAGE_ATTEMPTS);
});

test('a cover that arrives after an early miss is cached and reused without refetching', async () => {
  const store = await storeWithPrint();
  const missing = countingFetch(new Error('404'));
  await resolveCoverImage({ activityTokenStore: store, printerID: 'p', name: 'P', fetchCover: missing });

  const present = countingFetch('BASE64COVER');
  assert.equal(await resolveCoverImage({ activityTokenStore: store, printerID: 'p', name: 'P', fetchCover: present }), 'BASE64COVER');
  assert.equal(await resolveCoverImage({ activityTokenStore: store, printerID: 'p', name: 'P', fetchCover: present }), 'BASE64COVER');
  assert.equal(present.calls, 1);
});

test('a new print gets fresh attempts', async () => {
  const store = await storeWithPrint();
  const fetchCover = countingFetch(new Error('404'));
  for (let update = 0; update < 5; update += 1) {
    await resolveCoverImage({ activityTokenStore: store, printerID: 'p', name: 'P', fetchCover });
  }
  await store.startPrint({ printerID: 'p', printerName: 'P', startedAt: '2026-01-02T00:00:00.000Z' });
  await resolveCoverImage({ activityTokenStore: store, printerID: 'p', name: 'P', fetchCover });

  assert.equal(fetchCover.calls, MAX_COVER_IMAGE_ATTEMPTS + 1);
});

test('a cover still loading after waitMs is skipped for this update without counting a failure', async () => {
  const store = await storeWithPrint();
  let finish;
  const slow = () => new Promise((resolve) => { finish = resolve; });

  const startedAt = Date.now();
  assert.equal(await resolveCoverImage({ activityTokenStore: store, printerID: 'p', name: 'P', fetchCover: slow, waitMs: 20 }), null);
  assert.ok(Date.now() - startedAt < 1000, 'the update did not wait for the slow fetch');
  assert.equal(store.get('p').coverImageFailures ?? 0, 0);

  finish('LATE');
  const ready = countingFetch('BASE64COVER');
  assert.equal(await resolveCoverImage({ activityTokenStore: store, printerID: 'p', name: 'P', fetchCover: ready, waitMs: 20 }), 'BASE64COVER');
});

test('a slow cover fetch that fails after the deadline does not surface as an unhandled rejection', async () => {
  const store = await storeWithPrint();
  let fail;
  const slow = () => new Promise((resolve, reject) => { fail = reject; });
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    assert.equal(await resolveCoverImage({ activityTokenStore: store, printerID: 'p', name: 'P', fetchCover: slow, waitMs: 10 }), null);
    fail(new Error('FTPS gave up'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('settleWithin passes through a value or rejection that arrives in time', async () => {
  assert.equal(await settleWithin(Promise.resolve('ok'), 50), 'ok');
  await assert.rejects(settleWithin(Promise.reject(new Error('boom')), 50), /boom/);
  assert.equal(await settleWithin(new Promise(() => {}), 10), TIMED_OUT);
});

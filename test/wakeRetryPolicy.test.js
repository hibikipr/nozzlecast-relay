const test = require('node:test');
const assert = require('node:assert/strict');
const { WakeRetryPolicy } = require('../src/wakeRetryPolicy');

const MIN = 60 * 1000;

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('one of two devices registered still gets a retry (the 2026-10-18 partial-registration case)', () => {
  const c = clock();
  const policy = new WakeRetryPolicy({ now: c.now });
  policy.startPrint('vich2c', 2);
  c.advance(MIN);
  const retry = policy.check('vich2c', 1);
  assert.ok(retry, 'a device is still missing, so a retry is due');
  assert.equal(retry.attempt, 1);
  assert.equal(retry.reason, '1/2 devices registered');
});

test('no retry once every device that accepted push-to-start has registered', () => {
  const c = clock();
  const policy = new WakeRetryPolicy({ now: c.now });
  policy.startPrint('vich2c', 2);
  c.advance(10 * MIN);
  assert.equal(policy.check('vich2c', 2), null);
});

test('zero registrations is always a retry case, even with an unknown expected count', () => {
  const policy = new WakeRetryPolicy({ now: clock().now });
  const retry = policy.check('vich2c', 0);
  assert.ok(retry, 'relay started mid-print: retry right away');
  assert.equal(retry.reason, 'no device registered');
});

test('partial registration with an unknown expected count is left alone', () => {
  const policy = new WakeRetryPolicy({ now: clock().now });
  assert.equal(policy.check('vich2c', 1), null);
});

test('retries back off exponentially from the push-to-start wake', () => {
  const c = clock();
  const policy = new WakeRetryPolicy({ now: c.now });
  policy.startPrint('vich2c', 2);
  const sentAt = [];
  // Simulate the deployed ~30s correction cadence for 90 minutes.
  for (let elapsed = 0; elapsed <= 90 * MIN; elapsed += 30 * 1000) {
    if (policy.check('vich2c', 1)) {
      policy.recordWake('vich2c');
      sentAt.push(c.now() / MIN);
    }
    c.advance(30 * 1000);
  }
  assert.deepEqual(sentAt, [1, 3, 7, 15, 31, 63]);
});

test('the per-print cap stops retries', () => {
  const c = clock();
  const policy = new WakeRetryPolicy({ maxRetries: 2, now: c.now });
  policy.startPrint('vich2c', 2);
  for (let i = 0; i < 2; i += 1) {
    c.advance(60 * MIN);
    assert.ok(policy.check('vich2c', 1));
    policy.recordWake('vich2c');
  }
  c.advance(600 * MIN);
  assert.equal(policy.check('vich2c', 1), null);
});

test('a new print resets the retry count and the expected device count', () => {
  const c = clock();
  const policy = new WakeRetryPolicy({ maxRetries: 1, now: c.now });
  policy.startPrint('vich2c', 2);
  c.advance(MIN);
  policy.recordWake('vich2c');
  c.advance(60 * MIN);
  assert.equal(policy.check('vich2c', 1), null, 'cap reached for the first print');

  policy.startPrint('vich2c', 3);
  c.advance(MIN);
  const retry = policy.check('vich2c', 2);
  assert.ok(retry);
  assert.equal(retry.reason, '2/3 devices registered');
});

test('startPrint overwrites state created by an earlier check (onStart resets before push-to-start)', () => {
  const c = clock();
  const policy = new WakeRetryPolicy({ maxRetries: 1, now: c.now });
  policy.check('vich2c', 0); // creates unknown-expected state
  policy.recordWake('vich2c');
  assert.ok(policy.capReached('vich2c'));

  policy.startPrint('vich2c', null);
  assert.equal(policy.capReached('vich2c'), false, 'reset before push-to-start clears the old cap');
  policy.startPrint('vich2c', 2);
  c.advance(MIN);
  assert.equal(policy.check('vich2c', 1).reason, '1/2 devices registered');
});

test('printers are tracked independently', () => {
  const c = clock();
  const policy = new WakeRetryPolicy({ maxRetries: 1, now: c.now });
  policy.startPrint('vich2c', 1);
  policy.startPrint('samp1s', 1);
  c.advance(MIN);
  policy.recordWake('vich2c');
  assert.equal(policy.check('vich2c', 0), null);
  assert.ok(policy.check('samp1s', 0));
});

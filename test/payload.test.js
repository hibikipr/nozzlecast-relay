const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPushToStartPayload } = require('../src/payload');

test('buildPushToStartPayload produces the documented aps shape', () => {
  const now = new Date('2026-09-02T13:23:34.000Z');
  const payload = buildPushToStartPayload({ printerID: 'vich2c', printerName: 'Vic H2C', now });

  assert.equal(payload.aps.event, 'start');
  assert.equal(payload.aps.timestamp, Math.floor(now.getTime() / 1000));
  assert.equal(payload.aps['attributes-type'], 'PrintActivityAttributes');
  assert.deepEqual(payload.aps.attributes, { printerID: 'vich2c', printerName: 'Vic H2C' });
  assert.deepEqual(payload.aps.alert, { title: 'Print Started', body: 'Vic H2C is printing' });
});

test('buildPushToStartPayload content-state matches PrintActivityAttributes.ContentState keys', () => {
  const now = new Date('2026-09-02T13:23:34.000Z');
  const payload = buildPushToStartPayload({ printerID: 'vich2c', printerName: 'Vic H2C', now });
  const state = payload.aps['content-state'];

  assert.deepEqual(Object.keys(state).sort(), [
    'bedTempC', 'coverImage', 'currentLayer', 'estimatedEndAt', 'jobName',
    'liveSnapshot', 'nozzleTempC', 'progress', 'startedAt', 'stateLabel', 'totalLayers',
  ].sort());
  assert.equal(state.progress, 0);
  assert.equal(state.stateLabel, 'Printing');
  assert.equal(state.startedAt, Math.floor(now.getTime() / 1000));
  assert.equal(typeof state.startedAt, 'number');
  assert.equal(state.jobName, null);
  assert.equal(state.estimatedEndAt, null);
  assert.equal(state.currentLayer, null);
  assert.equal(state.totalLayers, null);
  assert.equal(state.nozzleTempC, null);
  assert.equal(state.bedTempC, null);
  assert.equal(state.coverImage, null);
  assert.equal(state.liveSnapshot, null);
});

test('buildPushToStartPayload sends startedAt as a Unix timestamp number, not a date string', () => {
  // ActivityKit always decodes a pushed content-state with Foundation's default JSONDecoder
  // date strategy (.deferredToDate), regardless of any custom strategy the app itself might use
  // elsewhere -- and that default expects a raw seconds-since-1970 number, not any string form
  // (ISO8601 or otherwise). Sending a string here is a type mismatch: APNs still accepts and
  // delivers the push (a clean 2xx), but the device can't construct ContentState from it, so the
  // Live Activity is simply never created, with no error surfaced anywhere to find. Confirmed
  // against a real deploy: an earlier ISO8601-string version of this field (even with fractional
  // seconds correctly stripped) still silently failed for exactly this reason.
  const now = new Date('2026-09-02T13:23:34.789Z');
  const payload = buildPushToStartPayload({ printerID: 'vich2c', printerName: 'Vic H2C', now });
  assert.equal(payload.aps['content-state'].startedAt, Math.floor(now.getTime() / 1000));
  assert.equal(typeof payload.aps['content-state'].startedAt, 'number');
});

test('buildPushToStartPayload defaults now to the current time', () => {
  const before = Date.now();
  const payload = buildPushToStartPayload({ printerID: 'vich2c', printerName: 'Vic H2C' });
  const after = Date.now();
  assert.ok(payload.aps.timestamp >= Math.floor(before / 1000));
  assert.ok(payload.aps.timestamp <= Math.floor(after / 1000));
});

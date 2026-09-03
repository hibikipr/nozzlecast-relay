const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPushToStartPayload, buildBackgroundWakePayload } = require('../src/payload');

// Fixed offset between Unix epoch (1970-01-01) and Apple's Foundation reference date
// (2001-01-01), in seconds -- what Swift's default (uncustomized) Date Codable conformance
// encodes/decodes against, per Apple's own docs on how ActivityKit decodes pushed content-state.
const APPLE_REFERENCE_DATE_UNIX_OFFSET = 978307200;

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
  assert.equal(state.startedAt, Math.floor(now.getTime() / 1000) - APPLE_REFERENCE_DATE_UNIX_OFFSET);
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

test('buildPushToStartPayload sends startedAt as a Foundation-reference-date number, not Unix epoch or a date string', () => {
  // ActivityKit always decodes a pushed content-state with Swift's default (uncustomized) Date
  // Codable conformance, regardless of any custom strategy the app itself might use elsewhere --
  // and that default encodes/decodes as timeIntervalSinceReferenceDate (seconds since
  // 2001-01-01), NOT timeIntervalSince1970 (Unix epoch) and not any string form. Sending a
  // string is a type mismatch APNs still accepts and delivers, but the device can't construct
  // ContentState from it (Live Activity silently never created). Sending Unix-epoch seconds
  // instead of reference-date seconds is more subtle: it's still a valid number so decoding
  // succeeds without error, but produces a Date roughly 55 years off from reality. Found via
  // code audit against Apple's ActivityKit push docs, not a live-deploy symptom -- unlike the
  // string-vs-number bug, a wrong-but-numeric startedAt wouldn't visibly break push-to-start
  // itself, just whatever the Live Activity UI shows for its start time.
  const now = new Date('2026-09-02T13:23:34.789Z');
  const payload = buildPushToStartPayload({ printerID: 'vich2c', printerName: 'Vic H2C', now });
  const expected = Math.floor(now.getTime() / 1000) - APPLE_REFERENCE_DATE_UNIX_OFFSET;
  assert.equal(payload.aps['content-state'].startedAt, expected);
  assert.equal(typeof payload.aps['content-state'].startedAt, 'number');
});

test('buildPushToStartPayload defaults now to the current time', () => {
  const before = Date.now();
  const payload = buildPushToStartPayload({ printerID: 'vich2c', printerName: 'Vic H2C' });
  const after = Date.now();
  assert.ok(payload.aps.timestamp >= Math.floor(before / 1000));
  assert.ok(payload.aps.timestamp <= Math.floor(after / 1000));
});

test('buildBackgroundWakePayload produces a plain content-available push, no alert', () => {
  const payload = buildBackgroundWakePayload();
  assert.deepEqual(payload, { aps: { 'content-available': 1 } });
});

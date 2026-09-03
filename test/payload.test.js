const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPushToStartPayload, buildActivityStatePayload, buildBackgroundWakePayload } = require('../src/payload');

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

test('buildPushToStartPayload passes Bambuddy enrichment fields through to content-state when given', () => {
  const now = new Date('2026-09-02T13:23:34.000Z');
  const estimatedEndAt = new Date('2026-09-02T13:33:34.000Z');
  const payload = buildPushToStartPayload({
    printerID: 'vich2c',
    printerName: 'Vic H2C',
    now,
    jobName: 'benchy.gcode',
    currentLayer: 10,
    totalLayers: 200,
    nozzleTempC: 220,
    bedTempC: 60,
    estimatedEndAt,
  });
  const state = payload.aps['content-state'];

  assert.equal(state.jobName, 'benchy.gcode');
  assert.equal(state.currentLayer, 10);
  assert.equal(state.totalLayers, 200);
  assert.equal(state.nozzleTempC, 220);
  assert.equal(state.bedTempC, 60);
  assert.equal(state.estimatedEndAt, Math.floor(estimatedEndAt.getTime() / 1000) - APPLE_REFERENCE_DATE_UNIX_OFFSET);
});

test('buildPushToStartPayload passes coverImage/liveSnapshot base64 strings through unchanged', () => {
  const now = new Date('2026-09-02T13:23:34.000Z');
  const payload = buildPushToStartPayload({
    printerID: 'vich2c',
    printerName: 'Vic H2C',
    now,
    coverImage: 'Zm9v',
    liveSnapshot: 'YmFy',
  });

  assert.equal(payload.aps['content-state'].coverImage, 'Zm9v');
  assert.equal(payload.aps['content-state'].liveSnapshot, 'YmFy');
});

test('buildBackgroundWakePayload produces a plain content-available push, no alert', () => {
  const payload = buildBackgroundWakePayload();
  assert.deepEqual(payload, { aps: { 'content-available': 1 } });
});

test('buildActivityStatePayload omits attributes-type/attributes/alert -- only meaningful at start', () => {
  const startedAt = new Date('2026-09-02T13:23:34.000Z');
  const payload = buildActivityStatePayload({ event: 'update', startedAt, progress: 0.5 });

  assert.equal(payload.aps.event, 'update');
  assert.equal(payload.aps['attributes-type'], undefined);
  assert.equal(payload.aps.attributes, undefined);
  assert.equal(payload.aps.alert, undefined);
});

test('buildActivityStatePayload reuses the original startedAt, not "now", for content-state', () => {
  const startedAt = new Date('2026-09-02T13:23:34.000Z');
  const now = new Date('2026-09-02T13:45:00.000Z');
  const payload = buildActivityStatePayload({ event: 'update', startedAt, progress: 0.5, now });

  assert.equal(payload.aps.timestamp, Math.floor(now.getTime() / 1000));
  assert.equal(
    payload.aps['content-state'].startedAt,
    Math.floor(startedAt.getTime() / 1000) - APPLE_REFERENCE_DATE_UNIX_OFFSET,
  );
});

test('buildActivityStatePayload carries progress and stateLabel through to content-state', () => {
  const startedAt = new Date('2026-09-02T13:23:34.000Z');
  const payload = buildActivityStatePayload({ event: 'update', startedAt, progress: 0.5, stateLabel: 'Printing' });

  assert.equal(payload.aps['content-state'].progress, 0.5);
  assert.equal(payload.aps['content-state'].stateLabel, 'Printing');
});

test('buildActivityStatePayload supports event: "end" with a final stateLabel', () => {
  const startedAt = new Date('2026-09-02T13:23:34.000Z');
  const payload = buildActivityStatePayload({ event: 'end', startedAt, progress: 1, stateLabel: 'Failed' });

  assert.equal(payload.aps.event, 'end');
  assert.equal(payload.aps['content-state'].progress, 1);
  assert.equal(payload.aps['content-state'].stateLabel, 'Failed');
});

test('buildActivityStatePayload sets dismissal-date 5 minutes after "now", as plain Unix epoch seconds', () => {
  // dismissal-date is a top-level aps key the system reads directly -- unlike content-state's
  // own Date fields, it is NOT Codable-decoded by the app's Swift struct, so it must stay plain
  // Unix epoch seconds (same convention as aps.timestamp), never toAppleReferenceTimestamp()'d.
  const startedAt = new Date('2026-09-02T13:23:34.000Z');
  const now = new Date('2026-09-02T14:00:00.000Z');
  const payload = buildActivityStatePayload({ event: 'end', startedAt, stateLabel: 'Complete', now });

  const expectedUnixSeconds = Math.floor(now.getTime() / 1000) + 5 * 60;
  assert.equal(payload.aps['dismissal-date'], expectedUnixSeconds);
  // Sanity check it's the Unix convention, not the reference-date one: the two differ by the
  // fixed 978307200s offset, so asserting equality against the plain Unix value is itself proof
  // this isn't accidentally reference-date-encoded.
  assert.notEqual(payload.aps['dismissal-date'], expectedUnixSeconds - 978307200);
});

test('buildActivityStatePayload omits dismissal-date for "update" -- only "end" is dismissing anything', () => {
  const startedAt = new Date('2026-09-02T13:23:34.000Z');
  const payload = buildActivityStatePayload({ event: 'update', startedAt, stateLabel: 'Printing' });

  assert.equal('dismissal-date' in payload.aps, false);
});

test('buildPushToStartPayload never sets dismissal-date -- starting an activity, not ending one', () => {
  const payload = buildPushToStartPayload({ printerID: 'vich2c', printerName: 'Vic H2C' });
  assert.equal('dismissal-date' in payload.aps, false);
});

test('buildActivityStatePayload defaults progress to 0 and stateLabel to "Printing"', () => {
  const startedAt = new Date('2026-09-02T13:23:34.000Z');
  const payload = buildActivityStatePayload({ event: 'update', startedAt });

  assert.equal(payload.aps['content-state'].progress, 0);
  assert.equal(payload.aps['content-state'].stateLabel, 'Printing');
});

test('buildActivityStatePayload passes Bambuddy enrichment fields through to content-state when given', () => {
  const startedAt = new Date('2026-09-02T13:23:34.000Z');
  const estimatedEndAt = new Date('2026-09-02T13:33:34.000Z');
  const payload = buildActivityStatePayload({
    event: 'update',
    startedAt,
    progress: 0.42,
    jobName: 'benchy.gcode',
    currentLayer: 100,
    totalLayers: 250,
    nozzleTempC: 220.5,
    bedTempC: 60,
    estimatedEndAt,
  });
  const state = payload.aps['content-state'];

  assert.equal(state.jobName, 'benchy.gcode');
  assert.equal(state.currentLayer, 100);
  assert.equal(state.totalLayers, 250);
  assert.equal(state.nozzleTempC, 220.5);
  assert.equal(state.bedTempC, 60);
  assert.equal(state.estimatedEndAt, Math.floor(estimatedEndAt.getTime() / 1000) - APPLE_REFERENCE_DATE_UNIX_OFFSET);
});

test('buildActivityStatePayload passes coverImage/liveSnapshot base64 strings through unchanged', () => {
  const startedAt = new Date('2026-09-02T13:23:34.000Z');
  const payload = buildActivityStatePayload({
    event: 'update',
    startedAt,
    coverImage: 'Zm9v',
    liveSnapshot: 'YmFy',
  });

  assert.equal(payload.aps['content-state'].coverImage, 'Zm9v');
  assert.equal(payload.aps['content-state'].liveSnapshot, 'YmFy');
});

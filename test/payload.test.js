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
  assert.equal(state.startedAt, now.toISOString());
  assert.equal(state.jobName, null);
  assert.equal(state.estimatedEndAt, null);
  assert.equal(state.currentLayer, null);
  assert.equal(state.totalLayers, null);
  assert.equal(state.nozzleTempC, null);
  assert.equal(state.bedTempC, null);
  assert.equal(state.coverImage, null);
  assert.equal(state.liveSnapshot, null);
});

test('buildPushToStartPayload defaults now to the current time', () => {
  const before = Date.now();
  const payload = buildPushToStartPayload({ printerID: 'vich2c', printerName: 'Vic H2C' });
  const after = Date.now();
  assert.ok(payload.aps.timestamp >= Math.floor(before / 1000));
  assert.ok(payload.aps.timestamp <= Math.floor(after / 1000));
});

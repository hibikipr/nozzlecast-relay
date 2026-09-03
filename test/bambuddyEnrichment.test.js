const test = require('node:test');
const assert = require('node:assert/strict');
const { enrichmentFromStatus } = require('../src/bambuddyEnrichment');

test('enrichmentFromStatus maps every documented field', () => {
  const now = new Date('2026-09-03T12:00:00.000Z');
  const status = {
    progress: 42,
    subtaskName: 'benchy.gcode',
    layerNum: 100,
    totalLayers: 250,
    remainingTime: 600,
    temperatures: { nozzle: 220.5, bed: 60 },
  };

  const enrichment = enrichmentFromStatus(status, { now });

  assert.equal(enrichment.progress, 0.42);
  assert.equal(enrichment.jobName, 'benchy.gcode');
  assert.equal(enrichment.currentLayer, 100);
  assert.equal(enrichment.totalLayers, 250);
  assert.equal(enrichment.nozzleTempC, 220.5);
  assert.equal(enrichment.bedTempC, 60);
  assert.equal(enrichment.estimatedEndAt.getTime(), now.getTime() + 600 * 1000);
});

test('enrichmentFromStatus divides progress by 100 (Bambuddy reports 0-100, not 0-1)', () => {
  assert.equal(enrichmentFromStatus({ progress: 100 }).progress, 1);
  assert.equal(enrichmentFromStatus({ progress: 0 }).progress, 0);
});

test('enrichmentFromStatus defaults every field to null when absent from status', () => {
  const enrichment = enrichmentFromStatus({});

  assert.equal(enrichment.progress, null);
  assert.equal(enrichment.jobName, null);
  assert.equal(enrichment.currentLayer, null);
  assert.equal(enrichment.totalLayers, null);
  assert.equal(enrichment.nozzleTempC, null);
  assert.equal(enrichment.bedTempC, null);
  assert.equal(enrichment.estimatedEndAt, null);
});

test('enrichmentFromStatus handles a missing temperatures object without throwing', () => {
  const enrichment = enrichmentFromStatus({ progress: 10 });
  assert.equal(enrichment.nozzleTempC, null);
  assert.equal(enrichment.bedTempC, null);
});

test('enrichmentFromStatus defaults now to the current time', () => {
  const before = Date.now();
  const enrichment = enrichmentFromStatus({ remainingTime: 60 });
  const after = Date.now();

  assert.ok(enrichment.estimatedEndAt.getTime() >= before + 60 * 1000);
  assert.ok(enrichment.estimatedEndAt.getTime() <= after + 60 * 1000);
});

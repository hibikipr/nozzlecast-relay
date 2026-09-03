const test = require('node:test');
const assert = require('node:assert/strict');
const { enrichmentFromStatus } = require('../src/bambuddyEnrichment');

test('enrichmentFromStatus maps every documented field, using Bambuddy\'s real snake_case keys', () => {
  const now = new Date('2026-09-03T12:00:00.000Z');
  const status = {
    progress: 42,
    subtask_name: 'benchy.gcode',
    layer_num: 100,
    total_layers: 250,
    remaining_time: 600,
    temperatures: { nozzle: 220.5, bed: 60 },
  };

  const enrichment = enrichmentFromStatus(status, { now });

  assert.equal(enrichment.progress, 0.42);
  assert.equal(enrichment.jobName, 'benchy.gcode');
  assert.equal(enrichment.currentLayer, 100);
  assert.equal(enrichment.totalLayers, 250);
  assert.equal(enrichment.nozzleTempC, 221); // rounded from 220.5 -- see the Int? rounding test below
  assert.equal(enrichment.bedTempC, 60);
  assert.equal(enrichment.estimatedEndAt.getTime(), now.getTime() + 600 * 1000);
});

test('enrichmentFromStatus does NOT read camelCase keys -- Bambuddy never sends them', () => {
  // Regression test: an earlier version of this file assumed camelCase (subtaskName, layerNum,
  // totalLayers, remainingTime), which is what the original design spec's field-mapping table
  // said -- confirmed wrong against a real deploy hitting the actual API, where these fields
  // came back silently null (not an error, just always-undefined property access) despite real
  // data being present under the snake_case keys. This fixture is shaped exactly like a real
  // GET /api/v1/printers/{id}/status response's relevant subset.
  const status = {
    progress: 100,
    subtaskName: 'wrong-key.gcode', // camelCase -- must be ignored
    layerNum: 999, // camelCase -- must be ignored
    totalLayers: 999, // camelCase -- must be ignored
    remainingTime: 999, // camelCase -- must be ignored
    subtask_name: 'right-key.gcode',
    layer_num: 31,
    total_layers: 31,
    remaining_time: 0,
    temperatures: { bed: 25.75, bed_target: 0, nozzle: 29.34375, nozzle_target: 0 },
  };

  const enrichment = enrichmentFromStatus(status);

  assert.equal(enrichment.jobName, 'right-key.gcode');
  assert.equal(enrichment.currentLayer, 31);
  assert.equal(enrichment.totalLayers, 31);
  assert.equal(enrichment.nozzleTempC, 29); // rounded from 29.34375
  assert.equal(enrichment.bedTempC, 26); // rounded from 25.75
});

test('enrichmentFromStatus rounds nozzleTempC/bedTempC to the nearest integer', () => {
  // PrintActivityAttributes.ContentState declares these as Swift Int?, matching the app's
  // existing Int-everywhere convention for displayed temps. Bambuddy's raw temperatures are
  // fractional Doubles -- confirmed as a real live bug: JSONDecoder's default Int decoding does
  // NOT truncate a fractional JSON number, it throws, and since ActivityKit decodes the entire
  // content-state as one struct, that one field failing silently failed the whole push-to-start
  // on-device (APNs itself still 200'd it, since Apple never validates against the app's actual
  // Swift types).
  const enrichment = enrichmentFromStatus({ temperatures: { nozzle: 74.59375, bed: 43.90625 } });
  assert.equal(enrichment.nozzleTempC, 75);
  assert.equal(enrichment.bedTempC, 44);
  assert.equal(typeof enrichment.nozzleTempC, 'number');
  assert.ok(Number.isInteger(enrichment.nozzleTempC));
  assert.ok(Number.isInteger(enrichment.bedTempC));
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
  const enrichment = enrichmentFromStatus({ remaining_time: 60 });
  const after = Date.now();

  assert.ok(enrichment.estimatedEndAt.getTime() >= before + 60 * 1000);
  assert.ok(enrichment.estimatedEndAt.getTime() <= after + 60 * 1000);
});

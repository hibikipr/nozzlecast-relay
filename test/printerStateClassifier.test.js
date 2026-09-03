const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyTransition, hmsErrorCodes } = require('../src/printerStateClassifier');

test('classifyTransition detects a start (any non-RUNNING state -> RUNNING)', () => {
  assert.equal(classifyTransition('FINISH', 'RUNNING'), 'start');
  assert.equal(classifyTransition('FAILED', 'RUNNING'), 'start');
  assert.equal(classifyTransition('IDLE', 'RUNNING'), 'start');
  assert.equal(classifyTransition('PREPARE', 'RUNNING'), 'start');
});

test('classifyTransition detects pause and resume', () => {
  assert.equal(classifyTransition('RUNNING', 'PAUSE'), 'pause');
  assert.equal(classifyTransition('PAUSE', 'RUNNING'), 'resume');
});

test('classifyTransition detects finish and failed from any prior state', () => {
  assert.equal(classifyTransition('RUNNING', 'FINISH'), 'finish');
  assert.equal(classifyTransition('PAUSE', 'FINISH'), 'finish');
  assert.equal(classifyTransition('RUNNING', 'FAILED'), 'failed');
  assert.equal(classifyTransition('PAUSE', 'FAILED'), 'failed');
});

test('classifyTransition returns null for no change', () => {
  assert.equal(classifyTransition('RUNNING', 'RUNNING'), null);
  assert.equal(classifyTransition('FINISH', 'FINISH'), null);
});

test('classifyTransition returns null for an unrecognized/irrelevant transition', () => {
  assert.equal(classifyTransition('PREPARE', 'SLICING'), null);
  assert.equal(classifyTransition('FINISH', 'IDLE'), null);
});

test('classifyTransition never re-fires finish/failed once already in that state', () => {
  assert.equal(classifyTransition('FINISH', 'FINISH'), null);
  assert.equal(classifyTransition('FAILED', 'FAILED'), null);
});

test('hmsErrorCodes extracts the code field from each entry', () => {
  const status = { hms_errors: [{ code: '0x10007', severity: 5 }, { code: '0x20001', severity: 3 }] };
  assert.deepEqual(hmsErrorCodes(status), new Set(['0x10007', '0x20001']));
});

test('hmsErrorCodes returns an empty set when hms_errors is missing or empty', () => {
  assert.deepEqual(hmsErrorCodes({}), new Set());
  assert.deepEqual(hmsErrorCodes({ hms_errors: [] }), new Set());
});

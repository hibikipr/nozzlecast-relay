const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyTransition } = require('../src/printerStateClassifier');

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

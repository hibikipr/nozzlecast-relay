const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isStartEvent,
  isProgressEvent,
  isEndEvent,
  progressFraction,
  endStateLabel,
  printerName,
  normalizedID,
} = require('../src/parsing');

test('isStartEvent matches Bambuddy\'s "Print Started"', () => {
  assert.equal(isStartEvent('Print Started'), true);
});

test('isStartEvent matches OctoPrint\'s bare "Started"', () => {
  assert.equal(isStartEvent('Started'), true);
});

test('isStartEvent is case-insensitive', () => {
  assert.equal(isStartEvent('PRINT STARTED'), true);
});

test('isStartEvent rejects non-start titles', () => {
  assert.equal(isStartEvent('Print 50% Complete'), false);
  assert.equal(isStartEvent('Bed Cooldown Complete'), false);
  assert.equal(isStartEvent(''), false);
  assert.equal(isStartEvent(undefined), false);
});

test('isProgressEvent matches a percentage anywhere in the title', () => {
  assert.equal(isProgressEvent('Print 50% Complete'), true);
  assert.equal(isProgressEvent('Print 5% Complete'), true);
  assert.equal(isProgressEvent('Print Started'), false);
  assert.equal(isProgressEvent('Print Complete'), false);
  assert.equal(isProgressEvent(''), false);
  assert.equal(isProgressEvent(undefined), false);
});

test('isEndEvent matches completion, failure, and cancellation titles', () => {
  assert.equal(isEndEvent('Print Complete'), true);
  assert.equal(isEndEvent('Print Finished'), true);
  assert.equal(isEndEvent('Print Failed'), true);
  assert.equal(isEndEvent('Print Cancelled'), true);
});

test('isEndEvent rejects a percentage-complete title even though it contains "complete"', () => {
  assert.equal(isEndEvent('Print 50% Complete'), false);
  assert.equal(isEndEvent('Print 100% Complete'), false);
});

test('isEndEvent rejects other "...Complete" titles on the same topic that aren\'t print completions', () => {
  assert.equal(isEndEvent('Bed Cooldown Complete'), false);
});

test('isEndEvent rejects start/unrelated titles', () => {
  assert.equal(isEndEvent('Print Started'), false);
  assert.equal(isEndEvent(''), false);
  assert.equal(isEndEvent(undefined), false);
});

test('progressFraction extracts a percentage as a 0-1 fraction', () => {
  assert.equal(progressFraction('Print 50% Complete'), 0.5);
  assert.equal(progressFraction('Print 5% Complete'), 0.05);
  assert.equal(progressFraction('Print 100% Complete'), 1);
});

test('progressFraction returns null when there is no percentage', () => {
  assert.equal(progressFraction('Print Started'), null);
  assert.equal(progressFraction(''), null);
  assert.equal(progressFraction(undefined), null);
});

test('endStateLabel maps title keywords to a human label', () => {
  assert.equal(endStateLabel('Print Failed'), 'Failed');
  assert.equal(endStateLabel('Print Cancelled'), 'Cancelled');
  assert.equal(endStateLabel('Print Complete'), 'Complete');
  assert.equal(endStateLabel('Print Finished'), 'Complete');
});

test('printerName extracts the prefix before the first colon', () => {
  assert.equal(printerName('Vic H2C: No AMS Version - 0.16mm layer, 2 walls, 15% infill'), 'Vic H2C');
  assert.equal(printerName('sam-p1s: Started'), 'sam-p1s');
});

test('printerName trims whitespace around the name', () => {
  assert.equal(printerName('  Vic H2C  : Started'), 'Vic H2C');
});

test('printerName returns null when there is no colon or the name is empty', () => {
  assert.equal(printerName('no colon here'), null);
  assert.equal(printerName(': Started'), null);
  assert.equal(printerName(''), null);
  assert.equal(printerName(undefined), null);
});

test('normalizedID lowercases and strips non-alphanumerics so both name forms match', () => {
  assert.equal(normalizedID('Vic H2C'), 'vich2c');
  assert.equal(normalizedID('vic-h2c'), 'vich2c');
  assert.equal(normalizedID('Sam P1S'), 'samp1s');
  assert.equal(normalizedID(''), '');
  assert.equal(normalizedID(undefined), '');
});

test('normalizedID is Unicode-aware, keeping accented letters like the Swift original', () => {
  assert.equal(normalizedID('Émile'), 'émile');
});

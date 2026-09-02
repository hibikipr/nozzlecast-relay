const test = require('node:test');
const assert = require('node:assert/strict');
const { isStartEvent, printerName, normalizedID } = require('../src/parsing');

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

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizedID } = require('../src/parsing');

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

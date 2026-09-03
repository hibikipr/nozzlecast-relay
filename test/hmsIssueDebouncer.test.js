const test = require('node:test');
const assert = require('node:assert/strict');
const { HmsIssueDebouncer } = require('../src/hmsIssueDebouncer');

test('a code present on fewer than threshold consecutive polls is not confirmed active', () => {
  const debouncer = new HmsIssueDebouncer({ threshold: 2 });
  const result = debouncer.observe('samp1s', [{ code: '0x10007', severity: 5 }]);
  assert.deepEqual(result, []);
});

test('a code present for threshold consecutive polls becomes confirmed active', () => {
  const debouncer = new HmsIssueDebouncer({ threshold: 2 });
  debouncer.observe('samp1s', [{ code: 'A', severity: 1 }]);
  const result = debouncer.observe('samp1s', [{ code: 'A', severity: 1 }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].code, 'A');
});

test('a single-poll absence does not immediately clear a confirmed code (survives the observed flakiness)', () => {
  const debouncer = new HmsIssueDebouncer({ threshold: 2 });
  debouncer.observe('samp1s', [{ code: 'A', severity: 1 }]);
  debouncer.observe('samp1s', [{ code: 'A', severity: 1 }]); // confirmed now
  const result = debouncer.observe('samp1s', []); // one poll where it's absent
  assert.equal(result.length, 1, 'a single-poll blip should not clear a confirmed code');
});

test('a code absent for threshold consecutive polls is cleared', () => {
  const debouncer = new HmsIssueDebouncer({ threshold: 2 });
  debouncer.observe('samp1s', [{ code: 'A', severity: 1 }]);
  debouncer.observe('samp1s', [{ code: 'A', severity: 1 }]); // confirmed
  debouncer.observe('samp1s', []); // absent poll 1 -- still tracked
  const result = debouncer.observe('samp1s', []); // absent poll 2 -- cleared
  assert.deepEqual(result, []);
});

test('a code reappearing before its absence streak clears resets the absence streak', () => {
  const debouncer = new HmsIssueDebouncer({ threshold: 2 });
  debouncer.observe('samp1s', [{ code: 'A', severity: 1 }]);
  debouncer.observe('samp1s', [{ code: 'A', severity: 1 }]); // confirmed
  debouncer.observe('samp1s', []); // absent poll 1
  debouncer.observe('samp1s', [{ code: 'A', severity: 1 }]); // reappears -- absence streak resets
  const result = debouncer.observe('samp1s', []); // absent poll 1 again, not poll 2
  assert.equal(result.length, 1, 'the earlier single absence should not have counted toward clearing');
});

test('observe() updates the returned entry to the latest data for that code', () => {
  const debouncer = new HmsIssueDebouncer({ threshold: 1 });
  debouncer.observe('samp1s', [{ code: 'A', severity: 3 }]);
  const result = debouncer.observe('samp1s', [{ code: 'A', severity: 1 }]);
  assert.equal(result[0].severity, 1);
});

test('a threshold of 1 confirms immediately on first observation', () => {
  const debouncer = new HmsIssueDebouncer({ threshold: 1 });
  const result = debouncer.observe('samp1s', [{ code: 'A', severity: 1 }]);
  assert.equal(result.length, 1);
});

test('reset() clears all tracked state for a printer', () => {
  const debouncer = new HmsIssueDebouncer({ threshold: 1 });
  debouncer.observe('samp1s', [{ code: 'A', severity: 1 }]); // confirmed
  debouncer.reset('samp1s');
  const result = debouncer.observe('samp1s', []);
  assert.deepEqual(result, []);
});

test('two different printers are tracked independently', () => {
  const debouncer = new HmsIssueDebouncer({ threshold: 1 });
  const a = debouncer.observe('samp1s', [{ code: 'A', severity: 1 }]);
  const b = debouncer.observe('vich2c', []);
  assert.equal(a.length, 1);
  assert.equal(b.length, 0);
});

test('defaults to a threshold of 2 when not specified', () => {
  const debouncer = new HmsIssueDebouncer();
  const result = debouncer.observe('samp1s', [{ code: 'A', severity: 1 }]);
  assert.deepEqual(result, []);
});

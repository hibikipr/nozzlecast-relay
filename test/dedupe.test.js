const test = require('node:test');
const assert = require('node:assert/strict');
const { StartEventDedupe } = require('../src/dedupe');

test('shouldTrigger returns true the first time a printer is seen', () => {
  const dedupe = new StartEventDedupe();
  assert.equal(dedupe.shouldTrigger('samp1s'), true);
});

test('shouldTrigger returns false for a repeat within the window', () => {
  let currentTime = 1000;
  const dedupe = new StartEventDedupe({ windowMs: 60000, now: () => currentTime });
  assert.equal(dedupe.shouldTrigger('samp1s'), true);
  currentTime += 5000;
  assert.equal(dedupe.shouldTrigger('samp1s'), false);
});

test('shouldTrigger returns true again once the window has elapsed', () => {
  let currentTime = 1000;
  const dedupe = new StartEventDedupe({ windowMs: 60000, now: () => currentTime });
  assert.equal(dedupe.shouldTrigger('samp1s'), true);
  currentTime += 60001;
  assert.equal(dedupe.shouldTrigger('samp1s'), true);
});

test('shouldTrigger tracks each printerID independently', () => {
  let currentTime = 1000;
  const dedupe = new StartEventDedupe({ windowMs: 60000, now: () => currentTime });
  assert.equal(dedupe.shouldTrigger('samp1s'), true);
  assert.equal(dedupe.shouldTrigger('vich2c'), true);
  currentTime += 5000;
  assert.equal(dedupe.shouldTrigger('samp1s'), false);
  assert.equal(dedupe.shouldTrigger('vich2c'), false);
});

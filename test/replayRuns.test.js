const test = require('node:test');
const assert = require('node:assert/strict');
const { RUNS } = require('../scripts/replayRuns');

// Not exercising replay-run.js itself (it's an interactive tool that sends real APNs traffic --
// no meaningful way to unit test it, same reasoning as this repo's other real-device-only paths).
// This just guards the run DATA against the kind of typo that would only otherwise surface by
// running the script live: a bad atSec ordering, an out-of-range progress, etc.
for (const [name, run] of Object.entries(RUNS)) {
  test(`replay run "${name}" is well-formed`, () => {
    assert.ok(Array.isArray(run.steps) && run.steps.length > 0, 'has at least one step');
    assert.equal(run.steps[0].kind, 'start', 'first step is always start');
    assert.equal(run.steps[0].atSec, 0, 'start is always at t=0');
    assert.equal(run.steps.at(-1).kind, 'end', 'last step is always end');

    let previousAtSec = -1;
    for (const step of run.steps) {
      assert.ok(step.atSec > previousAtSec, `atSec strictly increasing (${step.atSec} after ${previousAtSec})`);
      previousAtSec = step.atSec;

      assert.ok(['start', 'update', 'end'].includes(step.kind), `valid kind: ${step.kind}`);
      if (step.kind !== 'start') {
        assert.ok(typeof step.progress === 'number' && step.progress >= 0 && step.progress <= 1, `progress in [0,1]: ${step.progress}`);
        assert.ok(typeof step.stateLabel === 'string' && step.stateLabel.length > 0, 'has a stateLabel');
        assert.ok(typeof step.remainingTimeMinutes === 'number' && step.remainingTimeMinutes >= 0, `remainingTimeMinutes >= 0: ${step.remainingTimeMinutes}`);
      }
    }

    assert.ok(typeof run.totalLayers === 'number' && run.totalLayers > 0);
    assert.ok(typeof run.printerName === 'string' && run.printerName.length > 0);
  });
}

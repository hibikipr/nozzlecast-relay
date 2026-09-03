const test = require('node:test');
const assert = require('node:assert/strict');
const { BambuddyPoller } = require('../src/bambuddyPoller');

function fakeClient({ printers, statusByPrinterId }) {
  return {
    printers: async () => printers,
    status: async (id) => {
      const entry = statusByPrinterId[id];
      if (entry instanceof Error) throw entry;
      return entry;
    },
  };
}

function recordingCallbacks() {
  const calls = { start: [], pause: [], resume: [], finish: [], failed: [], correction: [] };
  return {
    calls,
    onStart: async (ctx) => calls.start.push(ctx),
    onPause: async (ctx) => calls.pause.push(ctx),
    onResume: async (ctx) => calls.resume.push(ctx),
    onFinish: async (ctx) => calls.finish.push(ctx),
    onFailed: async (ctx) => calls.failed.push(ctx),
    onCorrection: async (ctx) => calls.correction.push(ctx),
  };
}

test('the first poll of a printer establishes a baseline without firing any callback', async () => {
  const client = fakeClient({
    printers: [{ id: 1, name: 'Sam P1S' }],
    statusByPrinterId: { 1: { state: 'RUNNING', hms_errors: [] } },
  });
  const cb = recordingCallbacks();
  const poller = new BambuddyPoller({ bambuddyClient: client, intervalMs: 1000, correctionIntervalMs: 60000, ...cb });

  await poller.tick();

  assert.equal(cb.calls.start.length, 0);
});

test('a transition into RUNNING from any prior state fires onStart', async () => {
  const client = fakeClient({
    printers: [{ id: 1, name: 'Sam P1S' }],
    statusByPrinterId: { 1: { state: 'FINISH', hms_errors: [] } },
  });
  const cb = recordingCallbacks();
  const poller = new BambuddyPoller({ bambuddyClient: client, intervalMs: 1000, correctionIntervalMs: 60000, ...cb });

  await poller.tick(); // baseline: FINISH
  client.status = async () => ({ state: 'RUNNING', hms_errors: [] });
  await poller.tick(); // FINISH -> RUNNING

  assert.equal(cb.calls.start.length, 1);
  assert.equal(cb.calls.start[0].printerID, 'samp1s');
  assert.equal(cb.calls.start[0].name, 'Sam P1S');
});

test('RUNNING -> PAUSE fires onPause, PAUSE -> RUNNING fires onResume', async () => {
  const client = fakeClient({ printers: [{ id: 1, name: 'Sam P1S' }], statusByPrinterId: { 1: { state: 'RUNNING', hms_errors: [] } } });
  const cb = recordingCallbacks();
  const poller = new BambuddyPoller({ bambuddyClient: client, intervalMs: 1000, correctionIntervalMs: 60000, ...cb });

  await poller.tick(); // baseline: RUNNING
  client.status = async () => ({ state: 'PAUSE', hms_errors: [] });
  await poller.tick(); // RUNNING -> PAUSE
  assert.equal(cb.calls.pause.length, 1);

  client.status = async () => ({ state: 'RUNNING', hms_errors: [] });
  await poller.tick(); // PAUSE -> RUNNING
  assert.equal(cb.calls.resume.length, 1);
});

test('transitions to FINISH/FAILED fire onFinish/onFailed', async () => {
  const client = fakeClient({ printers: [{ id: 1, name: 'Sam P1S' }], statusByPrinterId: { 1: { state: 'RUNNING', hms_errors: [] } } });
  const cb = recordingCallbacks();
  const poller = new BambuddyPoller({ bambuddyClient: client, intervalMs: 1000, correctionIntervalMs: 60000, ...cb });

  await poller.tick(); // baseline: RUNNING
  client.status = async () => ({ state: 'FINISH', hms_errors: [] });
  await poller.tick();
  assert.equal(cb.calls.finish.length, 1);
  assert.equal(cb.calls.failed.length, 0);
});

test('issueSeverity/issueCount are null/null on ctx until an HMS entry clears the debounce threshold', async () => {
  const client = fakeClient({
    printers: [{ id: 1, name: 'Sam P1S' }],
    statusByPrinterId: { 1: { state: 'RUNNING', hms_errors: [{ code: 'A', severity: 1 }] } },
  });
  const cb = recordingCallbacks();
  const poller = new BambuddyPoller({ bambuddyClient: client, intervalMs: 1000, correctionIntervalMs: 0, ...cb });

  await poller.tick(); // baseline (no ctx observed yet)
  await poller.tick(); // first real observation of 'A' -- not confirmed yet (default threshold 2)
  assert.equal(cb.calls.correction[0].issueSeverity, null);

  await poller.tick(); // second consecutive observation -- confirmed now
  assert.equal(cb.calls.correction[1].issueSeverity, 'error');
  assert.equal(cb.calls.correction[1].issueCount, 1);
});

test('a fresh start resets the HMS issue tracker so a leftover error from the last job isn\'t instantly confirmed', async () => {
  const client = fakeClient({
    printers: [{ id: 1, name: 'Sam P1S' }],
    statusByPrinterId: { 1: { state: 'FINISH', hms_errors: [{ code: 'STALE_ERROR', severity: 1 }] } },
  });
  const cb = recordingCallbacks();
  const poller = new BambuddyPoller({ bambuddyClient: client, intervalMs: 1000, correctionIntervalMs: 0, ...cb });

  await poller.tick(); // baseline: FINISH, with STALE_ERROR present (never observed -- not active)
  client.status = async () => ({ state: 'RUNNING', hms_errors: [{ code: 'STALE_ERROR', severity: 1 }] });
  await poller.tick(); // start -- resets the tracker, then a single fresh observation, not confirmed

  assert.equal(cb.calls.start.length, 1);
  assert.equal(cb.calls.start[0].issueSeverity, null, 'a single post-start observation should not be confirmed yet');
});

test('badge fields never appear on finish/failed ctx even with active hms_errors', async () => {
  const client = fakeClient({ printers: [{ id: 1, name: 'Sam P1S' }], statusByPrinterId: { 1: { state: 'RUNNING', hms_errors: [{ code: 'A', severity: 1 }] } } });
  const cb = recordingCallbacks();
  const poller = new BambuddyPoller({ bambuddyClient: client, intervalMs: 1000, correctionIntervalMs: 60000, ...cb });

  await poller.tick(); // baseline
  await poller.tick(); // observe 1
  await poller.tick(); // observe 2 -- confirmed
  client.status = async () => ({ state: 'FAILED', hms_errors: [{ code: 'A', severity: 1 }] });
  await poller.tick(); // fails while the code is still technically present

  assert.equal(cb.calls.failed.length, 1);
  assert.equal(cb.calls.failed[0].issueSeverity, null);
  assert.equal(cb.calls.failed[0].issueCount, null);
});

test('onCorrection fires only after correctionIntervalMs has elapsed since the last one', async () => {
  let currentTime = 0;
  const client = fakeClient({ printers: [{ id: 1, name: 'Sam P1S' }], statusByPrinterId: { 1: { state: 'RUNNING', hms_errors: [] } } });
  const cb = recordingCallbacks();
  const poller = new BambuddyPoller({
    bambuddyClient: client,
    intervalMs: 1000,
    correctionIntervalMs: 10000,
    now: () => currentTime,
    ...cb,
  });

  await poller.tick(); // baseline established at t=0, lastCorrectionAt starts null (treated as 0)
  currentTime = 12000;
  await poller.tick(); // 12000ms since 0 >= 10000 -> fires
  assert.equal(cb.calls.correction.length, 1);

  currentTime = 15000;
  await poller.tick(); // only 3000ms since the correction at 12000 -> not yet
  assert.equal(cb.calls.correction.length, 1);

  currentTime = 23000;
  await poller.tick(); // 11000ms since the correction at 12000 -> fires again
  assert.equal(cb.calls.correction.length, 2);
});

test('onCorrection never fires while FINISH/FAILED (not "active")', async () => {
  const client = fakeClient({ printers: [{ id: 1, name: 'Sam P1S' }], statusByPrinterId: { 1: { state: 'FINISH', hms_errors: [] } } });
  const cb = recordingCallbacks();
  const poller = new BambuddyPoller({ bambuddyClient: client, intervalMs: 1000, correctionIntervalMs: 0, ...cb });

  await poller.tick(); // baseline
  client.status = async () => ({ state: 'FINISH', hms_errors: [{ code: 'X', severity: 1 }] });
  await poller.tick(); // still FINISH -- printer isn't active

  assert.equal(cb.calls.correction.length, 0);
});

test('a status() failure for one printer is logged and skipped, not thrown', async () => {
  const client = fakeClient({
    printers: [{ id: 1, name: 'Sam P1S' }],
    statusByPrinterId: { 1: new Error('network down') },
  });
  const cb = recordingCallbacks();
  const poller = new BambuddyPoller({ bambuddyClient: client, intervalMs: 1000, correctionIntervalMs: 60000, ...cb });

  await assert.doesNotReject(poller.tick());
});

test('a printers() failure is logged and skipped, not thrown', async () => {
  const client = { printers: async () => { throw new Error('network down'); } };
  const cb = recordingCallbacks();
  const poller = new BambuddyPoller({ bambuddyClient: client, intervalMs: 1000, correctionIntervalMs: 60000, ...cb });

  await assert.doesNotReject(poller.tick());
});

test('two different printers are tracked independently', async () => {
  const client = fakeClient({
    printers: [{ id: 1, name: 'Sam P1S' }, { id: 2, name: 'Vic H2C' }],
    statusByPrinterId: { 1: { state: 'FINISH', hms_errors: [] }, 2: { state: 'FINISH', hms_errors: [] } },
  });
  const cb = recordingCallbacks();
  const poller = new BambuddyPoller({ bambuddyClient: client, intervalMs: 1000, correctionIntervalMs: 60000, ...cb });

  await poller.tick(); // baseline for both

  client.status = async (id) => (id === 1 ? { state: 'RUNNING', hms_errors: [] } : { state: 'FINISH', hms_errors: [] });
  await poller.tick(); // only printer 1 starts

  assert.equal(cb.calls.start.length, 1);
  assert.equal(cb.calls.start[0].name, 'Sam P1S');
});

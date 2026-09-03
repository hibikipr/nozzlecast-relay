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
  const calls = { start: [], pause: [], resume: [], finish: [], failed: [], error: [], correction: [] };
  return {
    calls,
    onStart: async (ctx) => calls.start.push(ctx),
    onPause: async (ctx) => calls.pause.push(ctx),
    onResume: async (ctx) => calls.resume.push(ctx),
    onFinish: async (ctx) => calls.finish.push(ctx),
    onFailed: async (ctx) => calls.failed.push(ctx),
    onError: async (ctx) => calls.error.push(ctx),
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

test('a new HMS error code while active fires onError, a pre-existing one does not', async () => {
  const client = fakeClient({
    printers: [{ id: 1, name: 'Sam P1S' }],
    statusByPrinterId: { 1: { state: 'RUNNING', hms_errors: [{ code: 'PRE_EXISTING' }] } },
  });
  const cb = recordingCallbacks();
  const poller = new BambuddyPoller({ bambuddyClient: client, intervalMs: 1000, correctionIntervalMs: 60000, ...cb });

  await poller.tick(); // baseline includes PRE_EXISTING already

  client.status = async () => ({ state: 'RUNNING', hms_errors: [{ code: 'PRE_EXISTING' }] });
  await poller.tick(); // same error still present -> no new event
  assert.equal(cb.calls.error.length, 0);

  client.status = async () => ({ state: 'RUNNING', hms_errors: [{ code: 'PRE_EXISTING' }, { code: 'NEW_ONE' }] });
  await poller.tick(); // a genuinely new code appears
  assert.equal(cb.calls.error.length, 1);
  assert.deepEqual(cb.calls.error[0].newErrorCodes, ['NEW_ONE']);
});

test('a fresh start resets the HMS baseline so a leftover error from the last job doesn\'t fire', async () => {
  const client = fakeClient({
    printers: [{ id: 1, name: 'Sam P1S' }],
    statusByPrinterId: { 1: { state: 'FINISH', hms_errors: [{ code: 'STALE_ERROR' }] } },
  });
  const cb = recordingCallbacks();
  const poller = new BambuddyPoller({ bambuddyClient: client, intervalMs: 1000, correctionIntervalMs: 60000, ...cb });

  await poller.tick(); // baseline: FINISH, with STALE_ERROR present
  client.status = async () => ({ state: 'RUNNING', hms_errors: [{ code: 'STALE_ERROR' }] });
  await poller.tick(); // start -- STALE_ERROR is now the new baseline, not a "new" error

  assert.equal(cb.calls.start.length, 1);
  assert.equal(cb.calls.error.length, 0);
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

test('onCorrection and onError never fire while FINISH/FAILED (not "active")', async () => {
  const client = fakeClient({ printers: [{ id: 1, name: 'Sam P1S' }], statusByPrinterId: { 1: { state: 'FINISH', hms_errors: [] } } });
  const cb = recordingCallbacks();
  const poller = new BambuddyPoller({ bambuddyClient: client, intervalMs: 1000, correctionIntervalMs: 0, ...cb });

  await poller.tick(); // baseline
  client.status = async () => ({ state: 'FINISH', hms_errors: [{ code: 'X' }] });
  await poller.tick(); // still FINISH, a "new" error code appears but printer isn't active

  assert.equal(cb.calls.error.length, 0);
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

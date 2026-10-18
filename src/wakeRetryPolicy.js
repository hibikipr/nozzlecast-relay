const DEFAULT_MAX_RETRIES = 6;
const DEFAULT_BASE_DELAY_MS = 60 * 1000;

// Decides when to re-send the background wake that gets a device to register its per-activity
// push token (see index.js's sendBackgroundWake). One record per printer, reset on every observed
// print start.
//
// Two things this has to get right, both confirmed live:
//
// 1. A PARTIAL registration still needs a retry. The original retry only fired while a printer had
//    NO activity token at all. 2026-10-18: push-to-start went to two devices at 11:03:12, one
//    registered at 11:03:15, and the other didn't register until its app was opened at 11:21:52 --
//    18.6 minutes with that device's Live Activity frozen at its push-to-start state, and no retry,
//    because "one device registered" read as "done". So a retry is due while fewer devices have
//    registered than accepted the push-to-start, not just while none have.
//
// 2. Retries have to be spread out, not spent on consecutive correction ticks. With the deployed
//    15s poll / 20s correction interval, a retry on every tick used the whole per-print cap in about
//    three minutes, while late tokens have been observed landing 18.6 and 37.5 minutes after the
//    print started. Exponential backoff from the push-to-start wake (1, 2, 4, 8, 16, 32 min with the
//    defaults) covers roughly the first hour with the same number of wakes, which matters because
//    iOS rations background pushes per app -- spamming them eats the budget of the ones that count.
//
// expectedDevices is how many devices accepted the push-to-start. It's unknown (null) for a print
// that was already running when the relay started, since no push-to-start went out; then only the
// zero-registrations case can be detected, same as before.
class WakeRetryPolicy {
  constructor({ maxRetries = DEFAULT_MAX_RETRIES, baseDelayMs = DEFAULT_BASE_DELAY_MS, now = () => Date.now() } = {}) {
    this.maxRetries = maxRetries;
    this.baseDelayMs = baseDelayMs;
    this.now = now;
    this.byPrinter = new Map(); // printerID -> { expectedDevices, retries, lastWakeAt }
  }

  // Called right after push-to-start and its initial wake went out. That initial wake is the
  // baseline the first retry's delay counts from.
  startPrint(printerID, expectedDevices) {
    this.byPrinter.set(printerID, { expectedDevices, retries: 0, lastWakeAt: this.now() });
  }

  // Returns null when no retry should be sent now, or { attempt, maxRetries, reason } when one
  // should -- the caller sends the wake and then calls recordWake().
  check(printerID, registeredDevices) {
    let state = this.byPrinter.get(printerID);
    if (!state) {
      // No push-to-start was observed for this print (relay started mid-print). Retry
      // immediately the first time, then back off from there.
      state = { expectedDevices: null, retries: 0, lastWakeAt: null };
      this.byPrinter.set(printerID, state);
    }

    const missing = registeredDevices === 0
      || (state.expectedDevices !== null && registeredDevices < state.expectedDevices);
    if (!missing) return null;
    if (state.retries >= this.maxRetries) return null;

    const delay = this.baseDelayMs * 2 ** state.retries;
    if (state.lastWakeAt !== null && this.now() - state.lastWakeAt < delay) return null;

    const reason = registeredDevices === 0
      ? 'no device registered'
      : `${registeredDevices}/${state.expectedDevices} devices registered`;
    return { attempt: state.retries + 1, maxRetries: this.maxRetries, reason };
  }

  recordWake(printerID) {
    const state = this.byPrinter.get(printerID);
    if (!state) return;
    state.retries += 1;
    state.lastWakeAt = this.now();
  }

  capReached(printerID) {
    const state = this.byPrinter.get(printerID);
    return Boolean(state && state.retries >= this.maxRetries);
  }
}

module.exports = { WakeRetryPolicy };

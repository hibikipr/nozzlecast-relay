const { normalizedID } = require('./parsing');
const { classifyTransition, hmsErrorCodes, RUNNING, PAUSE } = require('./printerStateClassifier');

// Polls Bambuddy's own API directly for printer state, as an alternative trigger source to
// ntfy (see NTFY_TRIGGER_ENABLED/BAMBUDDY_POLL_TRIGGER_ENABLED in config.js -- both can run
// side by side, though that's not the intended steady state). Reacts only to *observed
// transitions*: the very first poll of a printer never fires a synthetic event -- e.g. an
// already-RUNNING printer discovered right after the relay restarts mid-print doesn't get a
// spurious duplicate push-to-start -- it just establishes a baseline to diff future polls
// against. This also means transitions are inherently deduped by construction (a callback only
// fires when the state actually changes), unlike the ntfy path's title-based StartEventDedupe.
class BambuddyPoller {
  constructor({
    bambuddyClient,
    intervalMs,
    correctionIntervalMs,
    onStart,
    onPause,
    onResume,
    onFinish,
    onFailed,
    onError,
    onCorrection,
    now = () => Date.now(),
  }) {
    this.bambuddyClient = bambuddyClient;
    this.intervalMs = intervalMs;
    this.correctionIntervalMs = correctionIntervalMs;
    this.onStart = onStart;
    this.onPause = onPause;
    this.onResume = onResume;
    this.onFinish = onFinish;
    this.onFailed = onFailed;
    this.onError = onError;
    this.onCorrection = onCorrection;
    this.now = now;
    this.timer = null;
    this.knownPrinters = new Map(); // printerID -> { state, hmsErrorCodes, lastCorrectionAt }
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    let printers;
    try {
      printers = await this.bambuddyClient.printers();
    } catch (error) {
      console.error('Bambuddy poller: printers() failed, will retry next interval:', error);
      return;
    }
    for (const printer of printers) {
      await this.pollOne(printer);
    }
  }

  async pollOne(printer) {
    const printerID = normalizedID(printer.name);
    let status;
    try {
      status = await this.bambuddyClient.status(printer.id);
    } catch (error) {
      console.error(`Bambuddy poller: status fetch failed for printer "${printer.name}", skipping this tick:`, error);
      return;
    }

    const previous = this.knownPrinters.get(printerID);
    const currentErrorCodes = hmsErrorCodes(status);

    if (!previous) {
      this.knownPrinters.set(printerID, { state: status.state, hmsErrorCodes: currentErrorCodes, lastCorrectionAt: null });
      return;
    }

    const transition = classifyTransition(previous.state, status.state);
    if (transition) {
      console.log(`Bambuddy poller: printer "${printer.name}" state ${previous.state} -> ${status.state} (${transition})`);
    }
    const ctx = { printerID, name: printer.name, status };

    if (transition === 'start') {
      await this.onStart(ctx);
      // A fresh start supersedes any other same-tick classification (a stray leftover HMS error
      // from the previous job, or an immediate correction) -- capture the baseline fresh here
      // and skip the rest of this tick's checks for this printer.
      this.knownPrinters.set(printerID, { state: status.state, hmsErrorCodes: currentErrorCodes, lastCorrectionAt: this.now() });
      return;
    }
    if (transition === 'pause') await this.onPause(ctx);
    else if (transition === 'resume') await this.onResume(ctx);
    else if (transition === 'finish') await this.onFinish(ctx);
    else if (transition === 'failed') await this.onFailed(ctx);

    const isActive = status.state === RUNNING || status.state === PAUSE;

    const newErrorCodes = [...currentErrorCodes].filter((code) => !previous.hmsErrorCodes.has(code));
    if (isActive && newErrorCodes.length > 0) {
      console.log(`Bambuddy poller: new HMS error code(s) for printer "${printer.name}": ${newErrorCodes.join(', ')}`);
      await this.onError({ ...ctx, newErrorCodes });
    }

    let lastCorrectionAt = previous.lastCorrectionAt;
    if (isActive && this.now() - (lastCorrectionAt || 0) >= this.correctionIntervalMs) {
      await this.onCorrection(ctx);
      lastCorrectionAt = this.now();
    }

    this.knownPrinters.set(printerID, { state: status.state, hmsErrorCodes: currentErrorCodes, lastCorrectionAt });
  }
}

module.exports = { BambuddyPoller };

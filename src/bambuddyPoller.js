const { normalizedID } = require('./parsing');
const { classifyTransition, RUNNING, PAUSE } = require('./printerStateClassifier');
const { HmsIssueDebouncer } = require('./hmsIssueDebouncer');
const { badgeFromEntries } = require('./hmsIssues');

// Polls Bambuddy's own API directly for printer state, as an alternative trigger source to
// ntfy (see NTFY_TRIGGER_ENABLED/BAMBUDDY_POLL_TRIGGER_ENABLED in config.js -- both can run
// side by side, though that's not the intended steady state). Reacts only to *observed
// transitions*: the very first poll of a printer never fires a synthetic event -- e.g. an
// already-RUNNING printer discovered right after the relay restarts mid-print doesn't get a
// spurious duplicate push-to-start -- it just establishes a baseline to diff future polls
// against. This also means transitions are inherently deduped by construction (a callback only
// fires when the state actually changes), unlike the ntfy path's title-based StartEventDedupe.
//
// Every ctx passed to a callback also carries issueSeverity/issueCount (see hmsIssues.js),
// computed from HmsIssueDebouncer's currently-confirmed HMS entries while the printer is active
// -- null/null otherwise (including on finish/failed, where a badge no longer means anything).
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
    onCorrection,
    now = () => Date.now(),
    hmsIssueDebouncer = new HmsIssueDebouncer(),
  }) {
    this.bambuddyClient = bambuddyClient;
    this.intervalMs = intervalMs;
    this.correctionIntervalMs = correctionIntervalMs;
    this.onStart = onStart;
    this.onPause = onPause;
    this.onResume = onResume;
    this.onFinish = onFinish;
    this.onFailed = onFailed;
    this.onCorrection = onCorrection;
    this.now = now;
    this.hmsIssueDebouncer = hmsIssueDebouncer;
    this.timer = null;
    this.knownPrinters = new Map(); // printerID -> { state, lastCorrectionAt, progress }
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
    const progress = typeof status.progress === 'number' ? status.progress / 100 : null;

    const previous = this.knownPrinters.get(printerID);

    if (!previous) {
      this.knownPrinters.set(printerID, { state: status.state, lastCorrectionAt: null, progress });
      return;
    }

    const transition = classifyTransition(previous.state, status.state);
    if (transition) {
      console.log(`Bambuddy poller: printer "${printer.name}" state ${previous.state} -> ${status.state} (${transition})`);
    }

    const isActive = status.state === RUNNING || status.state === PAUSE;

    // Read BEFORE any reset/re-observe this tick: "what was confirmed as of the moment just
    // before this transition" -- specifically for onFailed to tell a real HMS-backed failure
    // apart from a bare FAILED with nothing attached (a plain user stop, or a failure that
    // never actually raised a qualifying issue). Bambuddy's own frontend (PrintersPage.tsx's
    // classifyPrinterStatus) treats a bare FAILED with no HMS error as equivalent to FINISH --
    // only escalates to "error" when a real HMS code is attached.
    const priorIssueSeverity = badgeFromEntries(this.hmsIssueDebouncer.getConfirmed(printerID)).issueSeverity;

    // Also read BEFORE this tick's own data is stored: Bambuddy resets progress (and layer_num)
    // to 0 the moment state becomes FAILED -- confirmed live, a print paused at 63% read
    // progress: 0 on the very same poll its state flipped to FAILED. onFinish/onFailed use this
    // instead of the current (already-reset) status.progress, same reasoning as
    // priorIssueSeverity: data captured at the instant of an end transition can't be trusted to
    // describe what was actually true up to that point.
    const priorProgress = previous.progress;

    if (transition === 'start') {
      // A fresh start means a fresh activity -- whatever was tracked belonged to the previous
      // job (see HmsIssueDebouncer.reset()'s own reasoning). Observe this tick's own entries
      // fresh afterward so the badge, if any, starts its own confirm streak from this print.
      this.hmsIssueDebouncer.reset(printerID);
    }
    const confirmedIssues = isActive ? this.hmsIssueDebouncer.observe(printerID, status.hms_errors || []) : [];
    const badge = badgeFromEntries(confirmedIssues);
    const ctx = { printerID, name: printer.name, status, priorIssueSeverity, priorProgress, ...badge };

    if (transition === 'start') {
      await this.onStart(ctx);
      this.knownPrinters.set(printerID, { state: status.state, lastCorrectionAt: this.now(), progress });
      return;
    }
    if (transition === 'pause') await this.onPause(ctx);
    else if (transition === 'resume') await this.onResume(ctx);
    else if (transition === 'finish') await this.onFinish(ctx);
    else if (transition === 'failed') await this.onFailed(ctx);

    let lastCorrectionAt = previous.lastCorrectionAt;
    if (isActive && this.now() - (lastCorrectionAt || 0) >= this.correctionIntervalMs) {
      await this.onCorrection(ctx);
      lastCorrectionAt = this.now();
    }

    this.knownPrinters.set(printerID, { state: status.state, lastCorrectionAt, progress });
  }
}

module.exports = { BambuddyPoller };

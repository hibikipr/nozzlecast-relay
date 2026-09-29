const { normalizedID } = require('./parsing');
const { classifyTransition, RUNNING, PAUSE } = require('./printerStateClassifier');
const { HmsIssueDebouncer } = require('./hmsIssueDebouncer');
const { badgeFromEntries } = require('./hmsIssues');

// Polls Bambuddy's own API directly for printer state. The relay's only trigger source, since
// the ntfy/SSE one was removed -- that one could only ever see the events Bambuddy chose to
// notify on (start, 25/50/75%, end), so pause, resume and HMS issues were invisible to it.
//
// Reacts only to *observed transitions*: the very first poll of a printer never fires a synthetic
// event -- e.g. an already-RUNNING printer discovered right after the relay restarts mid-print
// doesn't get a spurious duplicate push-to-start -- it just establishes a baseline to diff future
// polls against. That also makes transitions deduped by construction (a callback only fires when
// the state actually changes), so no separate start-event dedupe window is needed. The one
// exception is onBaselineInactive, which lets the caller clean up an activity whose print ended
// while the relay was down.
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
    onBaselineInactive = async () => {},
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
    this.onBaselineInactive = onBaselineInactive;
    this.now = now;
    this.hmsIssueDebouncer = hmsIssueDebouncer;
    this.timer = null;
    this.ticking = false;
    this.knownPrinters = new Map(); // printerID -> { state, lastCorrectionAt, progress }
  }

  start() {
    const run = () => this.tick().catch((error) => {
      console.error('Bambuddy poller: tick failed unexpectedly, will retry next interval:', error);
    });
    run();
    this.timer = setInterval(run, this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // Never runs two ticks at once. setInterval fires on schedule regardless of whether the last
  // tick finished, and a tick still awaiting a push (enrichment image fetches, APNs) had not yet
  // recorded the new state -- so an overlapping tick saw the same old state, classified the same
  // transition, and fired the same event again: two push-to-starts, i.e. two Live Activities, for
  // one print. A tick that finds one in flight is skipped, not queued; the next interval picks up
  // whatever changed.
  async tick() {
    if (this.ticking) {
      console.log('Bambuddy poller: previous tick still running, skipping this one');
      return;
    }
    this.ticking = true;
    try {
      let printers;
      try {
        printers = await this.bambuddyClient.printers();
      } catch (error) {
        console.error('Bambuddy poller: printers() failed, will retry next interval:', error);
        return;
      }
      if (!Array.isArray(printers)) {
        console.error('Bambuddy poller: printers() returned a non-array response, will retry next interval');
        return;
      }
      // One printer's failure (a malformed status, a callback that throws) must not skip the
      // rest of the fleet this tick, and must never escape as an unhandled rejection -- that
      // crashes the whole relay process.
      for (const printer of printers) {
        try {
          await this.pollOne(printer);
        } catch (error) {
          console.error(`Bambuddy poller: polling printer "${printer?.name}" failed, continuing:`, error);
        }
      }
    } finally {
      this.ticking = false;
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
    if (!status || typeof status !== 'object') {
      console.error(`Bambuddy poller: empty/malformed status for printer "${printer.name}", skipping this tick`);
      return;
    }
    // Bambuddy keeps answering /status while it has lost the printer's MQTT connection, and the
    // state it reports then is not a real reading. Treating it as one meant a mid-print Wi-Fi
    // blip could read as RUNNING -> <something> -> RUNNING, i.e. a brand-new "start": a second
    // push-to-start and a wiped token list for a print that never stopped. A disconnected reading
    // is skipped exactly like a failed fetch -- the baseline stays at the last real state.
    if (status.connected === false) return;

    const progress = typeof status.progress === 'number' ? status.progress / 100 : null;
    const hmsEntries = Array.isArray(status.hms_errors) ? status.hms_errors : [];
    const isActive = status.state === RUNNING || status.state === PAUSE;

    const previous = this.knownPrinters.get(printerID);

    if (!previous) {
      this.knownPrinters.set(printerID, { state: status.state, lastCorrectionAt: null, progress });
      // The first reading after a relay restart can still owe a device something: a print that
      // ended while the relay was down never produced an observed transition, so its Live
      // Activity would otherwise never get an end push. The callback decides whether anything
      // is actually outstanding for this printer.
      if (!isActive) {
        await this.onBaselineInactive({ printerID, name: printer.name, status, issueSeverity: null, issueCount: null });
      }
      return;
    }

    const transition = classifyTransition(previous.state, status.state);
    if (transition) {
      console.log(`Bambuddy poller: printer "${printer.name}" state ${previous.state} -> ${status.state} (${transition})`);
    }

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
    const confirmedIssues = isActive ? this.hmsIssueDebouncer.observe(printerID, hmsEntries) : [];
    const badge = badgeFromEntries(confirmedIssues);
    const ctx = { printerID, name: printer.name, status, priorIssueSeverity, priorProgress, ...badge };

    // Any transition push already carries a full, fresh content-state, so it doubles as this
    // interval's correction. Without this a pause/resume could be followed by a correction push
    // on the very same tick -- two back-to-back pushes spending the device's private Live
    // Activity update budget on identical content.
    const correctionDue = isActive && this.now() - (previous.lastCorrectionAt || 0) >= this.correctionIntervalMs;
    const sendsCorrection = !transition && correctionDue;
    const lastCorrectionAt = transition || sendsCorrection ? this.now() : previous.lastCorrectionAt;

    // Recorded BEFORE the callbacks run, so a callback that throws can't leave the old state
    // behind for the next tick to re-classify into the same event and re-send it every tick.
    this.knownPrinters.set(printerID, { state: status.state, lastCorrectionAt, progress });

    if (transition === 'start') await this.onStart(ctx);
    else if (transition === 'pause') await this.onPause(ctx);
    else if (transition === 'resume') await this.onResume(ctx);
    else if (transition === 'finish') await this.onFinish(ctx);
    else if (transition === 'failed') await this.onFailed(ctx);
    else if (sendsCorrection) await this.onCorrection(ctx);
  }
}

module.exports = { BambuddyPoller };

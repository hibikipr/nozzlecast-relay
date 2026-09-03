const fs = require('node:fs/promises');
const path = require('node:path');

// One entry per printer, not per token: a printer only ever has one active print/activity at a
// time, and each new print gets a brand new ActivityKit per-activity push token (registered by
// the app once it starts observing that activity's own pushTokenUpdates) that fully replaces
// whatever was there before -- there's no sense in which two tokens are ever valid for the same
// printer simultaneously. Also tracks the print's startedAt/printerName, set independently by
// startPrint() when ntfy reports the print starting: every activity update/end push must carry
// ActivityKit's *entire* content-state (not a diff), so later update/end pushes need the
// original startedAt without the app having to send it back to us.
class ActivityTokenStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.entries = new Map(); // printerID -> entry
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const list = JSON.parse(raw);
      this.entries = new Map(list.map((entry) => [entry.printerID, entry]));
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.entries = new Map();
        return;
      }
      if (error instanceof SyntaxError || error instanceof TypeError) {
        console.error(`activity-tokens.json is corrupt (${error.message}); starting with an empty list`);
        this.entries = new Map();
        return;
      }
      throw error;
    }
  }

  get(printerID) {
    return this.entries.get(printerID);
  }

  // Called when ntfy reports a new print starting for this printer: resets whatever was tracked
  // before, since a new print means a new activity and therefore a stale (or as-yet-unregistered)
  // token for the old one.
  async startPrint({ printerID, printerName, startedAt }) {
    this.entries.set(printerID, {
      printerID,
      printerName,
      startedAt,
      token: null,
      environment: null,
      registeredAt: null,
    });
    await this.save();
  }

  // Called on POST /register-activity: records the app's freshly-observed per-activity push
  // token for this printer, replacing any previous one. Preserves startedAt/printerName already
  // tracked from startPrint() if present (the normal case, since ntfy's "Print Started" fires
  // before the app finishes observing its own activity's token); if registration somehow lands
  // first, creates a bare entry that startPrint() -- or an update/end event's own fallback --
  // fills in.
  async registerToken({ printerID, token, environment }) {
    const existing = this.entries.get(printerID);
    this.entries.set(printerID, {
      printerID,
      printerName: existing ? existing.printerName : null,
      startedAt: existing ? existing.startedAt : null,
      token,
      environment,
      registeredAt: new Date().toISOString(),
    });
    await this.save();
  }

  // Called when a push to this printer's token comes back dead (400/410): clears the token but
  // keeps startedAt/printerName in case a fresh registration for the same still-running print
  // arrives again.
  async clearToken(printerID) {
    const existing = this.entries.get(printerID);
    if (!existing) return;
    this.entries.set(printerID, {
      ...existing,
      token: null,
      environment: null,
      registeredAt: null,
    });
    await this.save();
  }

  list() {
    return Array.from(this.entries.values());
  }

  async save() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(this.list(), null, 2), 'utf8');
    await fs.rename(tmpPath, this.filePath);
  }
}

module.exports = { ActivityTokenStore };

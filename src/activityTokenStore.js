const fs = require('node:fs/promises');
const { AtomicJsonFile } = require('./atomicJsonFile');

// One entry per printer, each holding a LIST of per-activity push tokens -- one per device
// currently showing that print's Live Activity.
//
// This used to be a single `token` per printer, on the reasoning that a printer only has one
// print at a time so it only has one activity. That conflated "one activity per printer" with
// "one activity per printer per device", which is false the moment a second device runs the app:
// every device gets its own Live Activity for the same print, with its own independent ActivityKit
// token. Confirmed live 2026-09-08 -- a phone registered for "vich2c" at 08:15:52, an iPad
// registered for the same printer at 08:48:54, and the second registration silently evicted the
// first. Updates kept flowing with APNs 200s, but only to the iPad; the phone's Live Activity
// froze at whatever it last received, and nothing relay-side recorded the takeover.
//
// Also tracks the print's startedAt/printerName, set independently by startPrint() when the poller
// observes the print starting: every activity update/end push must carry ActivityKit's *entire*
// content-state (not a diff), so later update/end pushes need the original startedAt without the
// app having to send it back to us.
// Entries written before tokens became a list carry a single top-level token/environment/
// registeredAt. Reshape them on load rather than requiring anyone to delete activity-tokens.json:
// a deploy landing mid-print would otherwise lose the running print's startedAt and cached
// coverImage along with the token.
function migrateEntry(entry) {
  if (Array.isArray(entry.tokens)) return entry;
  const { token, environment, registeredAt, ...rest } = entry;
  return {
    ...rest,
    tokens: token ? [{ token, environment, registeredAt }] : [],
  };
}

class ActivityTokenStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.entries = new Map(); // printerID -> entry
    this._file = new AtomicJsonFile(filePath);
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const list = JSON.parse(raw);
      this.entries = new Map(list.map((entry) => [entry.printerID, migrateEntry(entry)]));
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

  // Every device currently registered for this printer's activity. Always an array, so callers
  // never have to distinguish "no entry" from "entry with no tokens".
  tokensFor(printerID) {
    return this.entries.get(printerID)?.tokens ?? [];
  }

  // Called when the poller observes a new print starting for this printer: resets whatever was tracked
  // before, since a new print means a new activity and therefore a stale (or as-yet-unregistered)
  // token for the old one -- including any cached coverImage, which is a render of the *previous*
  // job's sliced plate and must not leak into the new one's Live Activity.
  async startPrint({ printerID, printerName, startedAt }) {
    this.entries.set(printerID, {
      printerID,
      printerName,
      startedAt,
      tokens: [],
      coverImage: null,
    });
    await this.save();
  }

  // Called on POST /register-activity: adds this device's per-activity push token to the printer,
  // ALONGSIDE any other device already registered for the same print rather than replacing it.
  // Re-registering the same token (the app re-checks on every background wake) just refreshes its
  // registeredAt. Preserves startedAt/printerName/coverImage already tracked from startPrint() if
  // present (the normal case, since the poller's start transition fires before the app finishes
  // observing its own activity's token); if registration somehow lands first, creates a bare entry
  // that startPrint() -- or an update/end event's own fallback -- fills in.
  async registerToken({ printerID, token, environment }) {
    const existing = this.entries.get(printerID);
    const others = (existing?.tokens ?? []).filter((entry) => entry.token !== token);
    this.entries.set(printerID, {
      printerID,
      printerName: existing ? existing.printerName : null,
      startedAt: existing ? existing.startedAt : null,
      coverImage: existing ? existing.coverImage : null,
      tokens: [...others, { token, environment, registeredAt: new Date().toISOString() }],
    });
    await this.save();
  }

  // Called once per print, the first time coverImage is successfully fetched+downscaled (it's
  // static for the whole job, unlike liveSnapshot which is refetched on every update) --
  // caches the already-downscaled base64 JPEG so later updates reuse it without re-fetching or
  // re-encoding. No-op if the printer isn't tracked at all (e.g. the print already ended).
  async setCoverImage(printerID, coverImageBase64) {
    const existing = this.entries.get(printerID);
    if (!existing) return;
    this.entries.set(printerID, { ...existing, coverImage: coverImageBase64 });
    await this.save();
  }

  // Called when a push to one device comes back dead (400/410): drops just that device, leaving
  // every other device still watching this print untouched, and keeps startedAt/printerName in
  // case a fresh registration for the same still-running print arrives again.
  async removeToken(printerID, token) {
    const existing = this.entries.get(printerID);
    if (!existing) return;
    this.entries.set(printerID, {
      ...existing,
      tokens: existing.tokens.filter((entry) => entry.token !== token),
    });
    await this.save();
  }

  list() {
    return Array.from(this.entries.values());
  }

  save() {
    return this._file.write(() => this.list());
  }
}

module.exports = { ActivityTokenStore };

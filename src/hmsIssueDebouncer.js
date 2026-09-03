const DEFAULT_THRESHOLD = 2;

// Debounces Bambuddy's own hms_errors reporting -- confirmed live to flicker a code present,
// then absent, then present again across polls seconds apart with nothing about the printer
// actually changing (no print running, no state transition). A code only becomes "confirmed
// active" after being observed on `threshold` consecutive polls, and only stops being
// "confirmed active" after being absent for `threshold` consecutive polls -- a single-poll blip
// in either direction doesn't change what's reported as currently active.
class HmsIssueDebouncer {
  constructor({ threshold = DEFAULT_THRESHOLD } = {}) {
    this.threshold = threshold;
    this.trackedByPrinter = new Map(); // printerID -> Map<code, { entry, presentStreak, absentStreak, confirmed }>
  }

  // Call once per poll per printer with that poll's raw hms_errors entries (each needs at least
  // `code`; `severity` and anything else travels along on `entry` for badgeFromEntries to read).
  // Returns the list of entries currently "confirmed active" -- may include an entry not present
  // THIS particular tick if it hasn't yet cleared its absence streak.
  observe(printerID, entries) {
    const tracked = this.trackedByPrinter.get(printerID) || new Map();
    const seenCodes = new Set(entries.map((entry) => entry.code));

    for (const entry of entries) {
      const existing = tracked.get(entry.code);
      if (existing) {
        existing.entry = entry;
        existing.presentStreak += 1;
        existing.absentStreak = 0;
        if (existing.presentStreak >= this.threshold) existing.confirmed = true;
      } else {
        tracked.set(entry.code, {
          entry,
          presentStreak: 1,
          absentStreak: 0,
          confirmed: this.threshold <= 1,
        });
      }
    }

    for (const [code, state] of tracked) {
      if (!seenCodes.has(code)) {
        state.absentStreak += 1;
        state.presentStreak = 0;
        if (state.absentStreak >= this.threshold) {
          tracked.delete(code);
        }
      }
    }

    this.trackedByPrinter.set(printerID, tracked);
    return Array.from(tracked.values())
      .filter((state) => state.confirmed)
      .map((state) => state.entry);
  }

  // Called when a printer starts a new print: whatever was tracked belonged to the previous
  // job and must not bleed into the new one's badge (mirrors ActivityTokenStore.startPrint()'s
  // same reasoning for coverImage/token).
  reset(printerID) {
    this.trackedByPrinter.delete(printerID);
  }
}

module.exports = { HmsIssueDebouncer };

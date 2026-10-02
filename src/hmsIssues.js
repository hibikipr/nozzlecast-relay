// Bambuddy's HMS `severity` is Bambu's own alert level, decoded from the high 16 bits of the
// fault code, as of Bambuddy v1.2.5.7 (#2728) -- the same decoding Bambu Studio uses
// (DevHMSItem::parse_hms_info):
//   0 -> invalid alert
//   1 -> error: the task is stopped        (Bambu: red)
//   2 -> warning: the task is paused       (Bambu: yellow)
//   3 -> notification: no impact, prompt only (Bambu: blue)
//
// Before that release Bambuddy read `severity` from the fault's Part ID byte instead, so the
// number was effectively unrelated to the fault: a fault that paused a print could read 6 and
// render as "Info", while a harmless notification could read 2. This mapping used to follow
// Bambuddy's old labels (1/2 error, 3 warning); against the corrected values that would badge
// every paused print as an error and every notification as a warning.
//
// Collapsed to the badge's two tiers by what the printer actually did: stopped -> "error",
// paused -> "warning". Notifications and the invalid level never badge -- the exact incident
// that broke the earlier naive "any new code = Error" version was a standing advisory, not a
// print fault, and a notification is that same kind of thing.
function severityToTier(severity) {
  if (severity === 1) return 'error';
  if (severity === 2) return 'warning';
  return null; // 0 (invalid), 3 (notification), or missing/non-numeric/unknown
}

// Given a list of currently-active HMS entries (already debounced -- see hmsIssueDebouncer.js),
// computes the single issueSeverity/issueCount pair for the Live Activity badge. issueCount only
// counts qualifying (level 1 or 2) entries, so a notification sitting alongside a real fault
// doesn't inflate the badge's count; issueSeverity is "error" if any qualifying entry stopped the
// task, else "warning".
function badgeFromEntries(entries) {
  const qualifying = entries.filter((entry) => severityToTier(entry.severity) !== null);
  if (qualifying.length === 0) return { issueSeverity: null, issueCount: null };
  const issueSeverity = qualifying.some((entry) => severityToTier(entry.severity) === 'error') ? 'error' : 'warning';
  return { issueSeverity, issueCount: qualifying.length };
}

module.exports = { severityToTier, badgeFromEntries };

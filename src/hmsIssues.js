// Bambuddy's own severity tiers, confirmed from its frontend source
// (frontend/src/components/HMSErrorModal.tsx:905-916, getSeverityInfo), not guessed:
//   severity 1 -> "Fatal"   -> red
//   severity 2 -> "Serious" -> red
//   severity 3 -> "Warning" -> orange
//   severity 4, or anything else (Bambuddy's own default case) -> "Info" -> blue
// Collapsed to two tiers for the Live Activity badge, with Info deliberately excluded
// entirely rather than downgraded further: the exact incident that broke the earlier naive
// "any new code = Error" version (0x10007) is genuine severity 5, landing in Bambuddy's own
// Info default case -- its own UI colors that blue with a description that's a standing
// connectivity/config advisory ("enable Developer Mode"), not a print fault. Info should never
// surface as a badge at all, not even a "low" one.
function severityToTier(severity) {
  if (severity === 1 || severity === 2) return 'error';
  if (severity === 3) return 'warning';
  return null; // 4, 5, anything else, or missing/non-numeric
}

// Given a list of currently-active HMS entries (already debounced -- see hmsIssueDebouncer.js),
// computes the single issueSeverity/issueCount pair for the Live Activity badge. issueCount only
// counts qualifying (severity <= 3) entries, so an Info-tier entry sitting alongside a real one
// doesn't inflate the badge's count; issueSeverity is "error" if any qualifying entry is
// severity <= 2, else "warning" if the only qualifying entries are severity 3.
function badgeFromEntries(entries) {
  const qualifying = entries.filter((entry) => severityToTier(entry.severity) !== null);
  if (qualifying.length === 0) return { issueSeverity: null, issueCount: null };
  const issueSeverity = qualifying.some((entry) => severityToTier(entry.severity) === 'error') ? 'error' : 'warning';
  return { issueSeverity, issueCount: qualifying.length };
}

module.exports = { severityToTier, badgeFromEntries };

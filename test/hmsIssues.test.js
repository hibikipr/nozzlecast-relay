const test = require('node:test');
const assert = require('node:assert/strict');
const { severityToTier, badgeFromEntries } = require('../src/hmsIssues');

test('severityToTier maps 1/2 to error, 3 to warning, per Bambuddy\'s own getSeverityInfo', () => {
  assert.equal(severityToTier(1), 'error');
  assert.equal(severityToTier(2), 'error');
  assert.equal(severityToTier(3), 'warning');
});

test('severityToTier maps 4, 5, and anything else to null -- Info is never a badge', () => {
  // Regression guard: 0x10007/severity 5 is the exact real incident that broke the earlier
  // naive "any new code = Error" version. Bambuddy's own UI colors severity 5 blue (Info,
  // its default case) and describes it as a standing connectivity/config advisory, not a
  // print fault -- it must never produce a badge.
  assert.equal(severityToTier(4), null);
  assert.equal(severityToTier(5), null);
  assert.equal(severityToTier(99), null);
  assert.equal(severityToTier(undefined), null);
  assert.equal(severityToTier(null), null);
});

test('badgeFromEntries returns null/null when nothing qualifies', () => {
  assert.deepEqual(badgeFromEntries([]), { issueSeverity: null, issueCount: null });
  assert.deepEqual(badgeFromEntries([{ code: '0x10007', severity: 5 }]), { issueSeverity: null, issueCount: null });
});

test('badgeFromEntries returns "warning" when only severity-3 entries qualify', () => {
  const badge = badgeFromEntries([{ code: 'A', severity: 3 }]);
  assert.deepEqual(badge, { issueSeverity: 'warning', issueCount: 1 });
});

test('badgeFromEntries returns "error" if any qualifying entry is severity <= 2, even mixed with warnings', () => {
  const badge = badgeFromEntries([{ code: 'A', severity: 3 }, { code: 'B', severity: 1 }]);
  assert.deepEqual(badge, { issueSeverity: 'error', issueCount: 2 });
});

test('badgeFromEntries excludes Info-tier entries from the count entirely', () => {
  const badge = badgeFromEntries([
    { code: 'A', severity: 3 },
    { code: '0x10007', severity: 5 }, // must not inflate the count or affect severity
  ]);
  assert.deepEqual(badge, { issueSeverity: 'warning', issueCount: 1 });
});

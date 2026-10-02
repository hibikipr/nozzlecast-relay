const test = require('node:test');
const assert = require('node:assert/strict');
const { severityToTier, badgeFromEntries } = require('../src/hmsIssues');

// Bambu alert levels, as Bambuddy reports them since v1.2.5.7 (#2728):
// 0 invalid, 1 error (task stopped), 2 warning (task paused), 3 notification.

test('severityToTier maps a stopped-task fault (1) to error and a paused-task fault (2) to warning', () => {
  assert.equal(severityToTier(1), 'error');
  assert.equal(severityToTier(2), 'warning');
});

test('severityToTier never badges notifications, the invalid level, or unknown values', () => {
  assert.equal(severityToTier(3), null); // notification: no impact on the print
  assert.equal(severityToTier(0), null); // invalid alert
  assert.equal(severityToTier(6), null); // pre-#2728 garbage (Part ID byte), not a level
  assert.equal(severityToTier(undefined), null);
  assert.equal(severityToTier(null), null);
});

test('badgeFromEntries returns null/null when nothing qualifies', () => {
  assert.deepEqual(badgeFromEntries([]), { issueSeverity: null, issueCount: null });
  assert.deepEqual(badgeFromEntries([{ code: 'A', severity: 3 }]), { issueSeverity: null, issueCount: null });
});

test('badgeFromEntries returns "warning" when only paused-task faults qualify', () => {
  // The real case behind #2728: 0500-0600-0002-0005 paused an H2C and Bambuddy used to call it Info.
  const badge = badgeFromEntries([{ code: '0x20005', severity: 2 }]);
  assert.deepEqual(badge, { issueSeverity: 'warning', issueCount: 1 });
});

test('badgeFromEntries returns "error" if any qualifying entry stopped the task, even mixed with warnings', () => {
  const badge = badgeFromEntries([{ code: 'A', severity: 2 }, { code: 'B', severity: 1 }]);
  assert.deepEqual(badge, { issueSeverity: 'error', issueCount: 2 });
});

test('badgeFromEntries excludes notifications from the count entirely', () => {
  const badge = badgeFromEntries([
    { code: 'A', severity: 2 },
    { code: 'B', severity: 3 }, // must not inflate the count or affect severity
  ]);
  assert.deepEqual(badge, { issueSeverity: 'warning', issueCount: 1 });
});

# Live Activity issue badge (Bambuddy-style severity + count)

Follow-up to the HMS-error false positive (`e754b3d` disabled the naive "Error" update entirely).
The ask is for a proper badge instead — colored by severity, with a count, the same idea as
Bambuddy's own printer-card badge — rather than either "always say Error" (wrong, see the
0x10007 incident) or "never show anything" (current state).

## Confirmed severity contract (from Bambuddy's own source, not guessed)

`frontend/src/components/HMSErrorModal.tsx:905-916`, `getSeverityInfo(severity)`:

```
severity 1 → "Fatal"   → red
severity 2 → "Serious" → red
severity 3 → "Warning" → orange
severity 4, or anything else (default case) → "Info" → blue
```

Confirmed live: the exact incident that caused the false positive — `0x10007`
(`0500-0500-0001-0007`) — is genuine severity **5**, which falls through to the `default: Info`
case. Bambuddy's own UI colors it blue and describes it as: "The printer rejected a command
because it could not verify it... Enable Developer Mode on the printer, restart it, then start
the job again." This is the same standing "Developer LAN mode not enabled" advisory shown at the
top of Bambuddy's whole Printers page — a persistent connectivity/config advisory, not a
transient print fault, which is exactly why it flickered present/absent across polls with the
printer sitting idle the whole time. **Severity 4+/Info should never surface as a Live Activity
badge at all** — it's routine chatter, not a print-affecting issue.

## Noise filtering precedent already established in Bambuddy itself

Bambuddy hit this same class of problem before and solved it with `filterKnownHMSErrors`
(same file, exported "for use in badge counts"): keeps an HMS entry only if it's in the bundled
description catalog OR carries actionable firmware actions; drops uncataloged, non-actionable
entries as "transient junk" — their own comment cites a near-identical regression ("the
post-cancel 0C00_001B echo that re-introduces the FAILED-after-cancel '1 problem forever'
regression"). Worth applying the same principle here rather than trusting raw `hms_errors`
presence.

## Plan

### 1. Badge tiers — collapse Bambuddy's 4 severities into 2 for the Live Activity

- **Error (red)**: severity 1 or 2 (Fatal/Serious).
- **Warning (yellow)**: severity 3.
- **No badge at all**: severity 4/Info, or no active qualifying entries. This is the fix for the
  0x10007 case specifically — it must never produce a badge, full stop.

### 2. Reuse the debounce work already planned

`e754b3d`'s writeup already calls for requiring N consecutive polls before trusting a code's
presence (to survive the flakiness independently observed). That debounce should gate the badge
too — same underlying data, same reliability problem.

### 3. New ContentState fields (NozzleCast side — I'll handle this once the shape below is settled)

Add to `PrintActivityAttributes.ContentState` (`NozzleCastShared`):

```swift
public var issueSeverity: String? // "warning" | "error", nil when no active qualifying issue
public var issueCount: Int?       // count of currently active, debounced, severity>=3 entries
```

Relay sends these as plain strings/numbers in `content-state`, same pattern as every other field
— `null` when there's nothing to show. Widget renders a small colored circular badge (red/yellow
per `issueSeverity`) with `issueCount` inside, similar in spirit to Bambuddy's own printer-card
badge — I'll handle the actual SwiftUI layout once the data's flowing, no strong opinion needed
from the relay side on placement/sizing.

### 4. Relay-side computation

In `bambuddyEnrichment.js` (or a sibling), given the (debounced) list of currently-active HMS
entries for a printer:

- Filter to entries with `severity <= 3` (drop Info/4+ entirely — this is the actual fix for the
  false positive, more fundamental than just disabling the feature).
- `issueSeverity` = `"error"` if any remaining entry has `severity <= 2`, else `"warning"` if any
  remaining entry has `severity == 3`, else `null`.
- `issueCount` = count of remaining (severity `<=` 3) entries.

Feed this into the same `sendActivityUpdate` path that already pushes progress/temp updates —
doesn't need its own separate push type, just two more fields on the existing update payload.

### 5. Tests

- `getSeverityInfo`-equivalent mapping: severity 1/2 → error, 3 → warning, 4/5/unknown → null
  (explicitly test the real 0x10007/severity-5 case as a regression guard, given it's what broke
  this the first time).
- Debounce: a code present on fewer than N consecutive polls doesn't surface a badge.
- Full pipeline: a realistic multi-entry hms_errors list (mixed severities) maps to the correct
  single `issueSeverity`/`issueCount` pair.

## Status

**Implemented.** `hmsIssues.js` (`severityToTier`/`badgeFromEntries`, the severity-tier mapping
above) and `hmsIssueDebouncer.js` (`HmsIssueDebouncer`, threshold-2-by-default confirm/clear
streaks per code) are both new, pure/stateful modules respectively, wired into `BambuddyPoller`:
every tick, while a printer is active (`RUNNING`/`PAUSE`), its raw `hms_errors` are `observe()`d
and the resulting confirmed set is turned into `{issueSeverity, issueCount}` on the `ctx` handed
to every callback (`start`/`pause`/`resume`/`finish`/`failed`/`correction` — `null`/`null` on
`finish`/`failed`, since a badge means nothing once the print's over). `index.js` threads these
straight through `sendPushToStart`/`sendActivityUpdate` into `payload.js`'s `content-state`. The
old raw-presence-diffing `hmsErrorCodes()`/`onError` path from `e754b3d` is removed outright
(not just left disabled) now that this supersedes it entirely.

Verified against the real live regression case before deploying: `0x10007`/severity 5 (the exact
incident that broke the earlier version) still produces `{issueSeverity: null, issueCount: null}`
even once confirmed present across two polls — Info stays excluded regardless of debounce state.
A synthetic real severity-1 entry correctly produces `{issueSeverity: "error", issueCount: 1}`.

177/177 tests pass.

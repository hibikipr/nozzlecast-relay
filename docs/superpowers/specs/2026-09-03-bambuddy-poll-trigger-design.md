# Bambuddy-poll trigger (replacing ntfy for start/pause/error/stop/finish)

## Problem

The relay's only trigger source has been Bambuddy's own ntfy notifications: milestone-based
(start, ~25/50/75% progress, complete/failed), entirely on Bambuddy's own schedule, with no
visibility into pause or a live error condition, and no way to control update cadence
independently of those milestones. Victor asked for three related changes:

1. Trigger directly off Bambuddy's own printer-status API instead of ntfy.
2. Rely on ActivityKit's native countdown timer for time-remaining display between updates
   (rather than pushing on every ntfy percentage milestone), correcting drift with a periodic
   update every 5-10 minutes instead.
3. Also react to pause, a live error, and stop (in addition to the existing start/finish/failed
   coverage), none of which ntfy's notifications distinguish today.

Explicit requirement: don't delete the ntfy implementation, disable it via an environment
variable instead.

## Trigger source toggles

Two independent, optional booleans in `config.js`, both defaulting to preserve pre-existing
behavior for any deploy that predates this change:

| Var | Default | Effect |
|---|---|---|
| `NTFY_TRIGGER_ENABLED` | `true` (disabled only on exact `"false"`) | Starts/stops `NtfyWatcher` |
| `BAMBUDDY_POLL_TRIGGER_ENABLED` | `false` (enabled only on exact `"true"`) | Starts/stops `BambuddyPoller` |

Both can run simultaneously (not actively guarded against), though that's not the intended
steady state — running both means the same real-world event could double-fire (e.g. ntfy's
"Print Started" and the poller's own RUNNING-transition detection both firing push-to-start for
the same print). This deploy runs with ntfy disabled and polling enabled.

Neither trigger's code path is touched by the other's toggle — `onNtfyMessage`, `sendPushToStart`,
and `sendActivityUpdate` are all shared, trigger-source-agnostic functions; only which watcher
objects get constructed and started changes.

## BambuddyPoller

`bambuddyPoller.js`: polls `GET /api/v1/printers/` + `GET /api/v1/printers/{id}/status` every
`BAMBUDDY_POLL_INTERVAL_MS` (default 15000). Purely reactive to *observed transitions* — the
first poll of any printer only establishes a baseline, firing no callback, so a relay restart
mid-print doesn't produce a spurious duplicate push-to-start for a printer already `RUNNING`.
This also means transitions are inherently deduped by construction (a callback only fires when
the state actually changes) — no separate dedupe window needed, unlike the ntfy path's
title-based `StartEventDedupe`.

### State values: all four confirmed live

Bambuddy's OpenAPI schema types `state` as a bare string with no enum — it's passed straight
through from the underlying Bambu Lab MQTT `gcode_state`. `RUNNING`, `FINISH`, and `FAILED` were
confirmed pre-launch: Bambuddy's own endpoint descriptions reference them verbatim ("RUNNING
state only — paused time excluded", "acknowledge... after a finished/failed print... FINISH/
FAILED state"), and a real live status response showed `state: "FINISH"` after a completed
print. `PAUSE` was the one value this relay's (deliberately read-only) API key couldn't be used
to confirm before shipping — **confirmed 2026-09-03 against a real supervised pause**, exactly as
guessed:

```
Bambuddy poller: printer "Sam P1S" state RUNNING -> PAUSE (pause)
```

`printerStateClassifier.js` logs every observed raw transition specifically so a case like this
surfaces immediately rather than silently misfiring — it did here, and the guess was right.

### Transition -> event mapping

| Transition | Event fired | `stateLabel` |
|---|---|---|
| any state ≠ `RUNNING` → `RUNNING` | `start` (push-to-start) | — |
| `RUNNING` → `PAUSE` | update | `Paused` |
| `PAUSE` → `RUNNING` | update | `Printing` |
| any → `FINISH` | end | `Complete` |
| any → `FAILED` | end | `Failed` |
| new HMS error code while active (`RUNNING`/`PAUSE`) | update | `Error` |
| no other event, ≥ `LIVE_ACTIVITY_CORRECTION_INTERVAL_MS` since the last one, still active | update | current state's label |

"Error" is deliberately non-terminal (`event: "update"`, not `"end"`) — an HMS code appearing
mid-print (filament runout, spaghetti detection, a warning) doesn't necessarily mean the print
stopped; a genuinely fatal condition should also drive `state` to `FAILED` separately, which
already produces its own `end` push.

### HMS error diffing, not "is the list non-empty"

`hms_errors` is not necessarily empty at rest and is not necessarily cleared the moment a print
ends (confirmed live: a completed print's status still carried a standing HMS entry at one
point during this session). So `onError` only fires for a code that's newly appeared since the
*poller's own last observation* of that printer — a fresh `start` transition resets this baseline
immediately (to whatever's present at that moment), so a stale error from the previous job never
fires as "new" against the new one.

### Correction cadence replaces percentage-milestone-driven updates

With Bambuddy-poll as the trigger, updates are no longer tied to Bambuddy's own ntfy
25/50/75% milestones at all. Instead: `LIVE_ACTIVITY_CORRECTION_INTERVAL_MS` (default 10 minutes)
governs how often a plain correction update goes out to an active (RUNNING/PAUSE) print with no
other event to report, refreshing `estimatedEndAt` (and progress/temps/etc.) so ActivityKit's own
native countdown timer UI — which the app side is expected to use for continuous display between
these corrections, this relay has no part in that UI itself — doesn't drift far from reality.

### Reusing the poller's own status fetch

The poller already calls `bambuddyClient.status(id)` every tick to detect transitions.
`fetchEnrichment()`, `sendPushToStart()`, and `sendActivityUpdate()` all accept an optional
`prefetchedStatus`, so a poller-driven push reuses that same status object rather than a second,
redundant fetch of the exact same data a moment later.

## Not yet done / open items

- **`remaining_time` (and therefore `estimatedEndAt`) can't be trusted as-is.** Confirmed live on
  2026-09-03's first real poll-triggered test: Bambuddy reported `remaining_time: 3` both right
  at print start (`PREPARE -> RUNNING`) and again at 62% progress while paused — clearly a
  placeholder/stale value, not a real estimate, in at least these two situations. The Live
  Activity didn't appear on-device for that test at all (APNs itself returned a clean 200 for
  both push-to-start sends — confirmed by re-sending the actual reconstructed payload
  diagnostically — so this wasn't a rejected/dropped push). Suspected but not yet confirmed: an
  `estimatedEndAt` only ~3 seconds after `startedAt` producing a degenerate/already-elapsed
  timer range if the app uses `Text(timerInterval:)`/`ProgressView(timerInterval:)` for the
  native countdown this whole design is meant to support, which may fail to render entirely
  rather than just displaying a wrong number. Needs either: don't pass through an implausible
  `remaining_time` (e.g. suspiciously small relative to progress) as `estimatedEndAt` at all, or
  confirmation from the app side that a degenerate timer range isn't actually the problem.
- The exact HMS error → user-visible severity mapping is unrefined — every new code fires an
  update today regardless of severity; may need tuning once real HMS traffic is observed
  (Bambuddy's own status carries a `severity` field per entry that isn't used yet).
- Running both triggers simultaneously isn't guarded against (see toggles table above) — fine for
  now since this deploy runs with only one enabled at a time.

## Testing

`printerStateClassifier.test.js` (pure transition/HMS-diff logic) and `bambuddyPoller.test.js`
(the polling loop itself, via a fake `bambuddyClient` and injectable `now()`, no real timers)
cover: baseline-only first observation, every transition type, resume correctly distinguished
from a fresh start (a real bug caught here — `PAUSE -> RUNNING` was initially misclassified as
`start` before `resume` was checked first), new-vs-stale HMS error codes, a fresh start resetting
the HMS baseline, correction timing via a fake clock, and that a single printer's fetch failure
doesn't affect others or crash the tick loop. `config.test.js` covers both toggles' default and
explicit-value behavior. 150/150 tests pass overall.

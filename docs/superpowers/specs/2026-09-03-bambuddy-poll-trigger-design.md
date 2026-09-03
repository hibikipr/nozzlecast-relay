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

## Resolved during real testing (2026-09-03)

- **Push-to-start not rendering at all** turned out to be a *separate* bug, not this design's
  `estimatedEndAt` issue below: `nozzleTempC`/`bedTempC` are Swift `Int?`, and this relay was
  sending Bambuddy's raw fractional Doubles unrounded. One field failing to decode fails the
  entire `content-state` struct, silently, with APNs still returning a clean 200 throughout
  (Apple never validates a payload against the app's actual Swift types) — see the enrichment
  design doc's own changelog for the fix (`Math.round()` in `enrichmentFromStatus`).
- **`remaining_time` (and therefore `estimatedEndAt`) couldn't be trusted as-is** — confirmed
  live: `remaining_time: 3` both right at print start and again at 62% progress on the same
  job, clearly a placeholder/stale figure rather than a real estimate. Once the `Int?` bug above
  was fixed and push-to-start actually rendered, this surfaced exactly as suspected: progress
  showing 100% almost immediately with a still-ticking timer, since `PrintActivityWidget`'s
  `LiveProgressText` interpolates `elapsed / (estimatedEndAt - startedAt)` locally every second,
  and that fraction clamps to 1.0 almost instantly when the denominator is ~3 seconds. **Fixed**
  in `enrichmentFromStatus`/`isRemainingTimeTrustworthy`: `remaining_time` under 30 seconds is
  only trusted when progress is also ≥ 95% (a near-zero remaining time is only plausible near
  completion) — otherwise `estimatedEndAt` comes back `null` and the widget falls back to its
  non-interpolated `progress`-only display.
- **Manual stop labeled "Failed" instead of "Cancelled"** (matching Bambu Handy's own wording)
  — dug past the initial "probably opaque" read: Bambuddy's `PrintLogEntry.status` schema *does*
  support a `"cancelled"` value, but per `PrintLogEntryUpdate`'s own description that value is
  only ever set by a human manually reclassifying a row after the fact through a "Failure
  Analysis" editor (#1687) — Bambuddy's automatic classification at capture time only ever
  writes `"failed"`/`"completed"` for an active-print stop, confirmed against two real print-log
  entries from tonight's tests (`failure_reason: null` on both). So the distinction Bambu Handy
  shows almost certainly comes from a `print_error`/task-end reason code on the printer's own
  MQTT stream directly — real information Bambu Lab's firmware has, but which Bambuddy's own API
  layer (the only thing this relay can see) doesn't expose anywhere, in `/status` or
  automatically in `/print-log`. Not fixable from the relay side without a different data source.

## HMS-error → "Error" update: disabled after a real false positive (2026-09-03)

The `onError` path — new HMS code while active → `event: "update"`, `stateLabel: "Error"` — was
confirmed broken against real traffic and is now a **no-op** in `index.js` (detection/logging in
`BambuddyPoller` is untouched; only acting on it is disabled). Two independent problems, both
confirmed with real evidence, not assumed:

1. **`hms_errors` reporting is itself flaky.** The same code (`0x10007`) was observed present,
   then absent, then present again across polls seconds apart with nothing about the printer
   changing (no print running, no state transition). A single-poll "wasn't there last time, is
   there now" diff treats this routine flakiness as a fresh error on every reappearance.
2. **Severity isn't accounted for at all.** The exact incident that triggered the false "Error"
   activity — `0x10007`, `severity: 5` — coincided with Bambuddy's own dashboard showing this
   printer green/healthy with no HMS fault banner, only a routine "plate not cleared" post-print
   reminder. Whatever Bambu Lab's severity scale actually means numerically wasn't confirmed
   before this shipped; every new code was treated as equally error-worthy regardless.

Re-enabling this needs both fixed with real data, not another guess: a debounce (require a code
to be absent for N consecutive polls, not just one, before it's eligible to be flagged as "new"
again) for problem 1, and a confirmed severity floor (once Bambu Lab's actual scale direction is
known) for problem 2. Start/pause/resume/finish/failed/correction are unaffected — each was
separately confirmed correct against this same real testing session.

## Confirmed correct during the same investigation

- Neither print from this incident was left "stuck active" on the relay's side. The print with
  the HMS false-positive reached `PAUSE -> FAILED` and the relay correctly attempted (`event:
  "end"`, `stateLabel: "Failed"`) to push it — that attempt was itself skipped
  (`"No activity token registered ... skipping end push"`) because `/register-activity` never
  landed during that print's lifetime, a separate, already-understood registration-timing gap,
  not a new bug. The next print on the same printer registered in time and its own
  `RUNNING -> FAILED` transition produced a successfully delivered end push
  (`"Activity end sent for printer \"Sam P1S\" (progress=1)"`). So whatever stale
  Live-Activity state a user sees after a print whose registration never landed in time reflects
  that print's *last successfully delivered* push (its initial push-to-start content, in that
  case) — not the relay failing to recognize the print had ended.

## Not yet done / open items

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

# Bambuddy-poll trigger (replacing ntfy for start/pause/error/stop/finish)

## Problem

The relay's only trigger source has been Bambuddy's own ntfy notifications: milestone-based
(start, ~25/50/75% progress, complete/failed), entirely on Bambuddy's own schedule, with no
visibility into pause or a live error condition, and no way to control update cadence
independently of those milestones. Three related changes were requested:

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
  live: `remaining_time: 3` (minutes — see the units bug below) both right at print start and
  again at 62% progress on the same job, clearly a placeholder/stale figure rather than a real
  estimate. Once the `Int?` bug above was fixed and push-to-start actually rendered, this
  surfaced exactly as suspected: progress showing 100% almost immediately with a still-ticking
  timer, since `PrintActivityWidget`'s `LiveProgressText` interpolates
  `elapsed / (estimatedEndAt - startedAt)` locally every second, and that fraction clamps to 1.0
  almost instantly when the denominator is tiny. **Fixed** in
  `enrichmentFromStatus`/`isRemainingTimeTrustworthy`: `remaining_time` under
  `MIN_TRUSTED_REMAINING_TIME_MINUTES` is only trusted when progress is also ≥ 95% (a near-zero
  remaining time is only plausible near completion) — otherwise `estimatedEndAt` comes back
  `null` and the widget falls back to its non-interpolated `progress`-only display.
- **`remaining_time` units bug — read as seconds, actually minutes (2026-09-03, found later the
  same night)**: `enrichmentFromStatus` computed `estimatedEndAt = now + remaining_time` treating
  the value as seconds. Bambuddy's `GET /status` passes `remaining_time` straight through from
  the printer's raw MQTT `mc_remaining_time` field unconverted, and that field is minutes, not
  seconds — confirmed against Bambuddy's own backend source
  (`bambu_mqtt.py: self.state.remaining_time = int(data["mc_remaining_time"])`) and against
  NozzleCast's own app code, which already treats the same value correctly (`etaMinutesRemaining`,
  multiplied by 60 before use). Caught live on an H2C print: the relay's pushed `estimatedEndAt`
  read ~5:33 while Bambuddy's own dashboard showed ~6:45 for the same in-progress print — the
  live raw `remaining_time` was 68, and `now + 68 min` matches the dashboard exactly while
  `now + 68 sec` matches the wrong relay-pushed time. Every poll-trigger `estimatedEndAt` had
  been wrong by roughly a 60x factor since this feature shipped, except when `remaining_time`
  happened to be treated as an untrusted near-zero value (see above) and came back `null`
  instead. **Fixed**: `enrichmentFromStatus` now multiplies by `60 * 1000`, and
  `MIN_TRUSTED_REMAINING_TIME_MINUTES` (0.5, i.e. the same 30-second-equivalent floor, now
  correctly expressed in the field's real unit) replaces the old
  `MIN_TRUSTED_REMAINING_TIME_SECONDS = 30`. One follow-on consequence worth flagging: the
  "`remaining_time` stuck at 3 for an entire print" case documented below happened to read as
  "3 seconds" under the old (wrong) unit assumption, which cleared *under* the old 30-second
  floor and was therefore always rejected regardless of progress. Under the corrected minutes
  interpretation that same raw value (3 minutes) clears the new 0.5-minute floor immediately, so
  a print hitting that exact pathological case again would now show a perpetually-3-minutes-away
  `estimatedEndAt` instead of `null` — not re-tested against that specific test file since the
  fix, since drop-in fixed the units bug and no evidence yet that a stuck-minutes case will
  recur.
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

## HMS-error → "Error" update: disabled, then superseded by a proper badge (2026-09-03)

**Superseded — see `2026-09-03-hms-severity-badge-design.md`.** The section below is kept for the
investigation history; the raw-presence-diffing `onError`/`hmsErrorCodes()` path it describes no
longer exists in the code at all (not just disabled) — `BambuddyPoller` now feeds every tick's
`hms_errors` through `HmsIssueDebouncer` (fixing problem 1 below) and `severityToTier`/
`badgeFromEntries` (fixing problem 2, using Bambuddy's own confirmed severity scale rather than
a guessed direction), producing `issueSeverity`/`issueCount` on every callback's `ctx` instead of
a single `event: "update"`/`stateLabel: "Error"` push.

The `onError` path — new HMS code while active → `event: "update"`, `stateLabel: "Error"` — was
confirmed broken against real traffic and was made a **no-op** in `index.js` (detection/logging
in `BambuddyPoller` was left untouched; only acting on it was disabled). Two independent
problems, both confirmed with real evidence, not assumed:

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

## onFailed's stateLabel: "Failed" only when a real HMS issue backs it up (2026-09-03)

Resolves the cancel-vs-failed question above more directly than "genuinely opaque" turned out to
be the last word: confirmed straight from Bambuddy's own frontend (`PrintersPage.tsx`'s
`classifyPrinterStatus`) that Bambuddy itself treats a bare `FAILED` gcode_state with no HMS error
attached as equivalent to `FINISH` — its own comment: *"FAILED without an active HMS error is the
printer's terminal state after any unsuccessful end — including user-cancellations... only
escalate to error when an HMS code is attached."* So `onFailed` now checks
`HmsIssueDebouncer.getConfirmed()` (added alongside `observe()`/`reset()` — reads the currently
confirmed set without observing new data or mutating any streak) for whatever qualifying
(severity ≤ 3) issue was confirmed *just before* the failure, exposed on `ctx.priorIssueSeverity`
(computed before that tick's own reset/re-observe, since a `FAILED` tick isn't active and so
never re-observes `hms_errors` itself). The badge itself (`issueSeverity`/`issueCount` on the
failed push) stays `null`/`null` regardless, per the existing "a badge means nothing once the
print has ended" rule — only the stateLabel decision reads `priorIssueSeverity`.

**Correction (2026-09-03): the no-issue wording was wrong the first time round, fixed to
`"Stopped"` not `"Complete"`.** `classifyPrinterStatus`'s `'finished'` return value (grouping
`FAILED`-with-no-HMS-error alongside `FINISH`) is Bambuddy's internal bucket for badge/dot
*color* — it is not what Bambuddy displays as *text*. A separate function in the same file,
`getStatusDisplay`, still literally returns `"Failed"` as the label regardless of which color
bucket a status falls into; only the color/grouping changes, not the wording. Reusing the
bucket's name as the literal `stateLabel` was the mistake — `"Complete"` implies the print
succeeded, which is actively wrong for something a user manually stopped partway through.
`stateLabel` is now `"Failed"` when `priorIssueSeverity` is non-null (unchanged), `"Stopped"`
otherwise — accurately says the print ended without claiming success or implying a fault that
wasn't confirmed.

**Separate bug, same symptom, fixed alongside it:** `sendActivityUpdate` hardcoded
`progress: event === 'end' ? 1 : ...` for every end event. A genuinely finished print naturally
reads ~100% from real data anyway, so the hardcode was never actually doing anything useful there
— but for a stopped/cancelled print it was simply wrong, showing "100%" for a print that may have
been stopped at 60%. Now uses the same real progress source as update events
(`enrichment?.progress ?? fallbackProgress ?? 0`) for "end" too, no special-casing.

**Follow-up correction, found immediately on the first real test of the above (2026-09-03):**
removing the hardcode traded one wrong number for another. Confirmed live: Bambuddy resets
`progress` (and `layer_num`, same as observed once before) to `0` the instant `state` becomes
`FAILED` — a print paused at 63% read `progress: 0` on the very same poll its state flipped to
`FAILED`. Re-querying Bambuddy at the moment of the end transition itself is exactly the wrong
place to read progress from, same underlying problem `priorIssueSeverity` was built to solve for
the stateLabel decision. Fix: `BambuddyPoller` now also tracks each printer's last-observed
`progress` (alongside `state`) and exposes it as `ctx.priorProgress` — the value from the tick
*before* the transition, not the (already-reset) current one. `sendActivityUpdate` prefers
`priorProgress` over a fresh enrichment fetch specifically for `"end"` events (a fresh fetch is
still used for `"update"` events, where no such reset applies). `onFinish` gets this too, on the
assumption a moment-before snapshot is never worse than a potentially-just-reset current one,
even though FINISH hasn't been directly confirmed to exhibit the same reset.

## Correction interval lowered to 1 minute (2026-09-03)

`LIVE_ACTIVITY_CORRECTION_INTERVAL_MS=60000` in this deploy's `.env` (was the 10-minute default).
This deployment's print jobs run ~9 minutes, so the 10-minute correction never fired at all — the
only progress% update ever seen was whatever real state-change event happened to land (one print
jumped 1% → 63% at a pause, since that was the first content push since start). Also fixed a
related gap while making this change: `docker-compose.yml`'s `environment:` block never actually
passed `BAMBUDDY_POLL_INTERVAL_MS`/`LIVE_ACTIVITY_CORRECTION_INTERVAL_MS` through to the
container at all (both are optional in `config.js` with in-code defaults, but Compose only
forwards vars explicitly listed in `environment:`) — setting either in `.env` alone would have
been silently ignored before this.

Flagged separately (app-side, not a relay change): the percentage figure specifically may have
looked "frozen" for a more precise reason than just "corrections are rare" — `LiveProgressText`'s
`TimelineView(.periodic(...))` isn't one of the primitives Apple's Live Activity rendering
guarantees continuous system-driven refresh for (unlike `Text(.timer)` or
`ProgressView(timerInterval:)`, which is why the countdown clock and progress *bar* kept moving
smoothly on their own). **Resolved (2026-09-03, NozzleCast side):** the widget no longer tries to
interpolate a live percentage at all — both the bar and the number now read the printer's actual
last-reported `progress` directly, and the countdown clock was replaced with a localized
"Est. finish" time (date-styled `Text`, one of the primitives that *is* guaranteed continuous
refresh). The 1-minute correction interval above is still what keeps that real progress fresh
between real transitions.

## `remaining_time` staying implausible for an entire print (2026-09-03)

Confirmed not a relay bug: for at least one specific test G-code file that kept getting reprinted
("No AMS Version..." / "Grumpy Unicorn — Plate 6"), Bambuddy's `remaining_time` never moved off
~3 (minutes — see the units bug above; read as "~3 seconds" at the time this was investigated,
before the units bug was found) for the print's entire duration, regardless of real progress
climbing from 0% to 63%+ — reproduced identically across two separate full test runs. At the time,
the `estimatedEndAt` sanity check (reject an implausibly small `remaining_time`) was behaving
exactly as designed under the (wrong) seconds assumption: "3 seconds left" is exactly as
implausible at 63% progress as it is at 0%, so `estimatedEndAt` came back `null` for every push of
that specific print. Either the slicer's embedded time estimate is broken for that file, or
Bambuddy's remaining-time calculation doesn't work for it; not something fixable from the relay
side. Confirmed later the same night against a different, real print job all the way to
completion: `estimatedEndAt` populated correctly and the widget's "Est. finish" display worked as
intended — this really was a test-file-specific data gap, not a systemic bug, though see the units
bug entry above for how the *threshold* that happened to catch this specific case has since
changed (3 minutes now clears the corrected 0.5-minute floor and would no longer be rejected).

## Not yet done / open items

- Running both triggers simultaneously isn't guarded against (see toggles table above) — fine for
  now since this deploy runs with only one enabled at a time.

## Testing

`printerStateClassifier.test.js` (pure transition/HMS-diff logic) and `bambuddyPoller.test.js`
(the polling loop itself, via a fake `bambuddyClient` and injectable `now()`, no real timers)
cover: baseline-only first observation, every transition type, resume correctly distinguished
from a fresh start (a real bug caught here — `PAUSE -> RUNNING` was initially misclassified as
`start` before `resume` was checked first), new-vs-stale HMS error codes, a fresh start resetting
the HMS baseline, correction timing via a fake clock, `priorIssueSeverity`/`priorProgress`
correctly reflecting the tick *before* a FAILED transition rather than Bambuddy's own
already-reset current values, and that a single printer's fetch failure doesn't affect others or
crash the tick loop. `config.test.js` covers both toggles' default and explicit-value behavior.
185/185 tests pass overall (repo-wide, not just this file's suites).

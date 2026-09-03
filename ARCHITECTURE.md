# nozzlecast-relay: architecture

Current-state design reference for this repo, consolidated from the point-in-time design docs
under `docs/superpowers/specs/`. Those docs remain as the full investigation history (what broke,
how it was found, what was tried) — this document describes how the system actually works today.
Last reconciled: 2026-09-03.

## Problem this exists to solve

NozzleCast shows a Live Activity for an in-progress print. Starting one via
`Activity.request()` only works while the app is foreground — a hard ActivityKit restriction
(`ActivityAuthorizationError.visibility`) — so a print starting while the phone is locked (the
common case) would otherwise get no Live Activity until the app is next opened.

The only way to start a Live Activity purely from a push, with no app code running, is
ActivityKit's **push-to-start**: the app registers a push-to-start token, and a server sends a
specially-shaped APNs request. This relay is that server. Its scope grew past just *starting* the
activity: confirmed across extensive live testing that `Activity<PrintActivityAttributes>
.activities`/`.activityUpdates` cannot be relied on from *any* device-side code (foreground, NSE,
or background-woken app) to find and update/end a push-to-start-created activity. So the relay
also owns every progress/pause/error/end update for the activity's entire lifetime, pushed
directly to that activity's own per-activity APNs token — not just the initial start.

## Non-goals

- Multi-tenant/SaaS operation — built for one operator's own printers and devices.
- Replacing NozzleCast's ntfy → Firebase → NSE pipeline for in-app notification history / non-Live-
  Activity push notifications — untouched, orthogonal to this relay.
- A retry/dead-letter queue for failed APNs sends beyond what's described under Error handling —
  not justified at this volume (single operator, a handful of print-starts per day).

## Processes and modules

Single Node.js service (`nozzlecast-relay`), one process:

| Module | Responsibility |
|---|---|
| `index.js` | Orchestration: wires every other module together, owns `sendPushToStart`/`sendActivityUpdate`/`sendBackgroundWake`, the startup APNs auth check, and both trigger sources' callback wiring. |
| `config.js` | Env var parsing/validation/defaults. |
| `server.js` | Express HTTP API — the three `/register*` endpoint families plus `/healthz`. |
| `tokenStore.js` | Generic JSON-file-backed token store, used for both push-to-start tokens (`tokens.json`) and plain device tokens (`device-tokens.json`). |
| `activityTokenStore.js` | Per-printer (not per-token) JSON-file-backed store for the activity's own push token, keyed by `printerID` (`activity-tokens.json`). |
| `ntfyWatcher.js` | Persistent SSE connection to ntfy, one of two trigger sources. |
| `bambuddyPoller.js` | Polls Bambuddy's own API for printer state, the other trigger source. |
| `printerStateClassifier.js` | Pure `gcode_state` transition → event classification (`start`/`pause`/`resume`/`finish`/`failed`). |
| `hmsIssueDebouncer.js` | Debounces Bambuddy's flaky `hms_errors` presence across polls. |
| `hmsIssues.js` | Pure severity mapping: confirmed HMS entries → `{issueSeverity, issueCount}` badge. |
| `parsing.js` | ntfy title classification (`isStartEvent`/`isProgressEvent`/`isEndEvent`), `printerName`/`normalizedID`. |
| `dedupe.js` | `StartEventDedupe` — prevents a duplicate push-to-start from repeated ntfy start messages. |
| `bambuddyClient.js` | Minimal REST client for Bambuddy's API (`printers()`, `status()`, cover/snapshot/stream-token). |
| `printerIdCache.js` | `printerID` (relay's normalized identity) → Bambuddy's own numeric printer id. |
| `bambuddyEnrichment.js` | Pure mapping from a Bambuddy status DTO onto content-state enrichment fields. |
| `imageDownscale.js` | `sharp`-based resize+JPEG-quality-loop, matching the app's own image budget exactly. |
| `apnsAuth.js` | ES256 JWT construction/caching for APNs auth (per environment). |
| `apnsClient.js` | Raw HTTP/2 POST to APNs, `shouldRemoveToken`/`ok` result shape. |
| `payload.js` | Builds the three APNs payload shapes (push-to-start, activity update/end, background wake). |

## Token stores

Three separate JSON files under `/data` (mounted volume, survives restarts/redeploys):

- **`tokens.json`** — ActivityKit push-to-start tokens, one entry per device: `{ token,
  environment, registeredAt }`.
- **`device-tokens.json`** — plain APNs device tokens, same shape, used for the background-wake
  push.
- **`activity-tokens.json`** — one entry per **printer** (not per token — a printer only ever has
  one live activity at a time, and a fresh registration always fully replaces whatever was tracked
  for that printer): `{ printerID, printerName, startedAt, token, environment, registeredAt }`.
  `printerName`/`startedAt` are set independently of `token`/`environment`/`registeredAt`: the
  former come from the print-start event, the latter from the app's `/register-activity` call,
  which normally arrives slightly *after* the start event. Every activity update/end push has to
  carry ActivityKit's entire content-state (not a diff), so the original `startedAt` has to survive
  independently of whenever the token itself shows up.

All three are loaded at startup and rewritten on every register/deregister/prune.

## HTTP API

- `POST /register` / `DELETE /register` — bearer-token protected (`RELAY_AUTH_SECRET`). Body
  `{ token, environment }`. Upserts/removes by token value in `tokens.json`.
- `POST /register-device` / `DELETE /register-device` — same shape and auth, against
  `device-tokens.json`.
- `POST /register-activity` — same auth. Body `{ token, printerID, environment }`. Upserts into
  `activity-tokens.json`, keyed by `printerID` (re-normalized server-side through the same
  `normalizedID()` the relay uses internally, so a lookup always matches even if the app forwards
  something other than the exact `attributes.printerID` it was given at start). Logs
  `Registered activity token for printer "X" (environment)` on success — added specifically so a
  registration's exact arrival time is visible in logs (see Background wake retry below for why
  that mattered). No `DELETE /register-activity` — a stale token is superseded by the next print's
  registration, or cleared automatically on a dead-token APNs response.
- `GET /healthz` — unauthenticated, for the Docker healthcheck.

## Trigger sources

Two independent, optional trigger sources, both feeding the same `sendPushToStart`/
`sendActivityUpdate` functions — neither's code path is touched by the other's toggle, only which
watcher objects get constructed and started changes:

| Var | Default | Effect |
|---|---|---|
| `NTFY_TRIGGER_ENABLED` | `true` (disabled only on exact `"false"`) | Starts/stops `NtfyWatcher` |
| `BAMBUDDY_POLL_TRIGGER_ENABLED` | `false` (enabled only on exact `"true"`) | Starts/stops `BambuddyPoller` |

Both can run simultaneously (not actively guarded against, but not the intended steady state — the
current deploy runs with ntfy disabled and polling enabled).

### ntfy trigger

Persistent SSE connection to `GET {NTFY_SERVER}/{NTFY_TOPIC}/sse`, authenticated with
`NTFY_AUTH_TOKEN`. Reconnects with exponential backoff (1s → 30s cap) on drop; no missed-message
replay. `NTFY_SERVER` must point at ntfy's internal Docker address, not a public NPM-proxied
hostname — NPM's default `proxy_buffering` stalls SSE streams entirely (confirmed: a request
through NPM never delivered even ntfy's own immediate handshake message).

`parsing.js` classifies an incoming title into one of three buckets:
- `isStartEvent(title)`: contains `"start"`.
- `isProgressEvent(title)`: contains a percentage (`/\d+\s*%/`).
- `isEndEvent(title)`: deliberately conservative — a percentage title never counts (checked
  first), and bare `"complete"`/`"finish"` only count when `"print"` also appears, since Bambuddy
  sends other `"...Complete"` titles on the same topic that aren't print completions (e.g.
  `"Bed Cooldown Complete"`). `"fail"`/`"cancel"` don't need that guard.

Milestone-based only (start, whatever percentages Bambuddy happens to post, complete/failed) — no
visibility into pause or a live error, and no independent control over update cadence. This is why
the Bambuddy-poll trigger exists.

### Bambuddy-poll trigger

`bambuddyPoller.js` polls `GET /api/v1/printers/` + `GET /api/v1/printers/{id}/status` every
`BAMBUDDY_POLL_INTERVAL_MS` (default 15000), reacting only to *observed transitions*: the first
poll of any printer only establishes a baseline (no callback fires), so a relay restart mid-print
doesn't produce a spurious duplicate push-to-start. Transitions are inherently deduped by
construction — a callback only fires when the state actually changes.

**State values** (`gcode_state`, passed straight through from the underlying Bambu Lab MQTT field):
`RUNNING`, `PAUSE`, `FINISH`, `FAILED` — all four confirmed live.

**Transition → event mapping:**

| Transition | Event | `stateLabel` |
|---|---|---|
| any state ≠ `RUNNING` → `RUNNING` | `start` (push-to-start) | — |
| `RUNNING` → `PAUSE` | update | `Paused` |
| `PAUSE` → `RUNNING` | update | `Printing` |
| any → `FINISH` | end | `Complete` |
| any → `FAILED`, with a confirmed qualifying HMS issue just prior | end | `Failed` |
| any → `FAILED`, no qualifying issue (includes plain user-stop) | end | `Stopped` |
| no other event, ≥ `LIVE_ACTIVITY_CORRECTION_INTERVAL_MS` since the last one, still active | update | current state's label |

`resume` (`PAUSE → RUNNING`) must be checked before the generic start check — a real bug caught
by a unit test before ever running live.

**`onFailed`'s stateLabel** depends on `HmsIssueDebouncer.getConfirmed()` at the instant just
*before* the failure (`ctx.priorIssueSeverity`) — confirmed straight from Bambuddy's own frontend
(`PrintersPage.tsx`'s `classifyPrinterStatus`) that Bambuddy itself treats a bare `FAILED` with no
HMS error attached as equivalent to `FINISH` for grouping, including user-cancellations. Bambuddy's
own `getStatusDisplay` still always shows the literal text `"Failed"` regardless of that grouping
bucket, though — the color/grouping distinction is not a wording distinction — so `"Stopped"` (not
`"Complete"`, which wrongly implies success) is used for the no-issue case instead of reusing the
grouping bucket's name.

**Progress at end events** uses `ctx.priorProgress` (the poller's last-observed value, from the
tick *before* the transition), not a fresh status fetch — confirmed live that Bambuddy resets
`progress` (and `layer_num`) to `0` the instant `state` becomes `FAILED`, so re-querying at the
moment of the end event itself would read the wrong (already-reset) number. `onFinish` uses the
same field on the assumption a moment-before snapshot is never worse, though FINISH hasn't been
directly confirmed to exhibit the same reset.

**Correction cadence** (`LIVE_ACTIVITY_CORRECTION_INTERVAL_MS`, default 10 minutes, this deploy
runs 1 minute since real print jobs run ~9 minutes) replaces percentage-milestone-driven updates
entirely: an active (`RUNNING`/`PAUSE`) print with no other event to report still gets a periodic
correction push, refreshing `estimatedEndAt`/progress/temps so ActivityKit's own native countdown
timer/progress display (the app side's job, not this relay's) doesn't drift far from reality.
`bambuddyPoller.js`'s own status fetch is reused (`prefetchedStatus`) by whichever
`sendPushToStart`/`sendActivityUpdate` call it triggers, rather than a second redundant fetch.

**HMS issue badge**: while a printer is active, its raw `hms_errors` are run through
`HmsIssueDebouncer.observe()` (requires a code to be confirmed present/absent across N consecutive
polls before trusting a change — `hms_errors` reporting is itself flaky, confirmed live: the same
code observed present/absent/present across polls seconds apart with nothing about the printer
changing) and then `badgeFromEntries()` (Bambuddy's own confirmed severity scale — see
`HMSErrorModal.tsx`'s `getSeverityInfo`: 1=Fatal, 2=Serious, 3=Warning, 4+/unknown=Info),
collapsing to two tiers: `"error"` (severity ≤ 2), `"warning"` (severity 3), or `null`/`null`
(severity 4+/Info, or nothing confirmed active) — Info-tier codes must never surface a badge at
all, confirmed live that a genuine severity-5 code was firing false "Error" activities while
Bambuddy's own dashboard showed the printer green/healthy. A fresh `start` transition resets the
debouncer's baseline for that printer. The badge is `null`/`null` on `finish`/`failed` — it means
nothing once the print has ended. An earlier version of this feature diffed raw `hms_errors`
presence directly (any newly-appeared code → `stateLabel: "Error"`); that path has been removed
entirely, not just disabled, superseded by the debounced/severity-filtered badge above.

## Registration flows (app → relay)

1. **Push-to-start token**: app observes `Activity<PrintActivityAttributes>.pushToStartTokenUpdates`
   and POSTs to `/register`.
2. **Device token** (background wake): app POSTs its plain APNs device token to `/register-device`.
   Even with push-to-start firing correctly, a push-to-start-created activity never populated
   `Activity<PrintActivityAttributes>.activities` in any process — app, NSE, or widget — until the
   app ran its own `PrintLiveActivityManager.sync` at least once (confirmed against a real device:
   the activity appeared and sat frozen through every subsequent push until manually foregrounded
   once). The relay fires a `content-available` background push to every registered device token
   alongside push-to-start to trigger that sync without the user opening the app.
3. **Per-activity token**: the app observes every activity's own `pushTokenUpdates` stream (the one
   thing Apple's docs guarantee the system wakes the app to deliver) and POSTs it to
   `/register-activity` with `{ token, printerID, environment }`. This is the token every
   subsequent update/end push for that printer's print goes to directly — no dependency on the
   app/NSE/widget ever running again after the initial push-to-start.

## Trigger: start (push-to-start)

1. Trigger source (ntfy title match, or the poller's own transition detection) fires.
2. `activityTokenStore.startPrint()` records this print's start, resetting any token left over
   from a previous print for this printer.
3. `sendPushToStart` builds the content-state (see Payload shapes below) and sends push-to-start
   to every registered push-to-start token, then sends the background-wake push to every
   registered device token (see Background wake retry below).

## Trigger: update/end (activity update/end)

1. Look up `activity-tokens.json` by `printerID`. **If there's no token registered yet, log and
   retry the background wake push** (see below) rather than just skipping silently.
2. Build the content-state reusing the *tracked* `startedAt` (not "now" — every push carries the
   complete content-state, not a diff, and the print's real start time doesn't change mid-print).
3. Send to the same APNs topic/push-type as push-to-start (Apple distinguishes by `aps.event`, not
   push-type header), with no `attributes-type`/`attributes`/`alert` — those are only meaningful
   when an activity is being created.

## Background wake retry (2026-09-03)

The one-shot `content-available` wake at print-start relies on iOS delivering a background push
promptly, but that delivery is **discretionary** and can be delayed with no relay-visible signal —
confirmed live on a real print where the wake was evidently delayed by iOS, leaving the activity
stale for ~37.5 minutes with nothing to retry it until something unrelated (foregrounding the app)
happened to trigger the sync on its own.

Fix: `sendBackgroundWake(name)` (extracted from the push-to-start flow) is called again from
`sendActivityUpdate`'s no-token branch, so a dropped/delayed wake gets retried on every
update/end attempt for as long as a printer has no activity token registered — naturally
piggybacking on the poll trigger's correction-interval tick (~once a minute at this deploy's
`LIVE_ACTIVITY_CORRECTION_INTERVAL_MS`) until `/register-activity` lands, then stops. This is why
`/register-activity`'s success log line (see HTTP API above) was added — without it there was no
way to see exactly when a registration arrived, only bound it to a ~1-minute window via the
"no token" log lines disappearing.

**Known tradeoff, not yet mitigated**: a genuinely offline/unreachable device on a long print will
get a wake retry on every correction tick for the print's entire duration. Worth widening
`LIVE_ACTIVITY_CORRECTION_INTERVAL_MS` if that proves too chatty against APNs in practice — no cap
on retry count/duration has been added.

## Enrichment (Bambuddy telemetry)

`bambuddyEnrichment.js`'s `enrichmentFromStatus(status)` maps a Bambuddy `/status` DTO onto
content-state fields, called through `index.js`'s `fetchEnrichment()` — a fail-open wrapper with
**three independent try/catch boundaries**, not one shared one:

1. Numeric telemetry (`status` fetch + `enrichmentFromStatus`) — failure here means "nothing to
   send, fall back to text-only fields."
2. `coverImage` fetch — failure here costs only that field.
3. `liveSnapshot` fetch — failure here costs only that field.

These were originally one shared `try`/`catch`; confirmed live that a single camera-endpoint `503`
(Bambuddy's camera endpoints are meaningfully less reliable than its status endpoint) discarded an
otherwise-fully-successful enrichment entirely, sending `progress: 0`/`estimatedEndAt: null` for a
print that was actually well underway — froze the display until the next event happened to
succeed. Splitting the boundaries means an image-endpoint hiccup now costs exactly one field, never
the whole update.

**Field mapping** (all snake_case on the wire — confirmed against a real deploy, not the camelCase
an earlier version assumed):

| ContentState field | Bambuddy status field | Notes |
|---|---|---|
| `progress` | `status.progress / 100` | Preferred over the ntfy title's regex-parsed percentage — exact, not text-parsed. Title-parsed value is the fallback when enrichment fails entirely. |
| `jobName` | `status.subtask_name` | |
| `currentLayer` | `status.layer_num` | |
| `totalLayers` | `status.total_layers` | |
| `nozzleTempC` | `Math.round(status.temperatures.nozzle)` | Swift side declares `Int?`; Bambuddy's raw values are fractional Doubles, and `JSONDecoder`'s default `Int` decoding does not truncate — it throws, silently failing the *entire* content-state struct (APNs still 200s regardless, since Apple never validates a payload against the app's actual Swift types). |
| `bedTempC` | `Math.round(status.temperatures.bed)` | Same reasoning. |
| `estimatedEndAt` | `now + status.remaining_time minutes` (see below) | |
| `coverImage` | `GET /cover?token=...`, downscaled, cached per print | See Images below. |
| `liveSnapshot` | `GET /camera/snapshot?token=...`, downscaled, fetched fresh every update | See Images below. |

### `remaining_time` units and trust

`status.remaining_time` is passed straight through by Bambuddy from the printer's raw MQTT
`mc_remaining_time` field, which is reported in **minutes, not seconds** — confirmed against
Bambuddy's own backend source (`bambu_mqtt.py: self.state.remaining_time =
int(data["mc_remaining_time"])`) and against NozzleCast's own app code, which already treats the
same field correctly (`etaMinutesRemaining`, multiplied by 60 before use). An earlier version of
this relay treated it as seconds — every poll-trigger `estimatedEndAt` was wrong by ~60x from when
the feature shipped until this was caught (a live relay-pushed ETA of ~5:33 vs. Bambuddy's own
dashboard showing ~6:45 for the same in-progress print; `remaining_time` was 68, and `now + 68 min`
matches the dashboard while `now + 68 sec` matches the wrong figure). Fixed: `estimatedEndAt = now
+ remainingTimeMinutes * 60 * 1000`.

A near-zero `remaining_time` is only trusted (i.e. not just discarded as an implausible
placeholder) when progress is also ≥ 95% (`NEAR_COMPLETION_PROGRESS`) — confirmed live that a
specific test G-code file reported `remaining_time: 3` (minutes) both right at print start and
again at 62% progress, clearly a stale/placeholder figure rather than a real estimate for that
file specifically (a different, real print completed with `estimatedEndAt` working correctly the
whole way through, so this isn't systemic). `MIN_TRUSTED_REMAINING_TIME_MINUTES = 0.5` is the
floor below which a reading needs that near-completion progress to be trusted at all — the same
30-second-equivalent floor as before the units fix, just now correctly expressed in the field's
real unit. One known consequence of the units fix: the specific pathological test file above (a
raw value of 3) now clears the 0.5-minute floor immediately and would show a perpetually-
3-minutes-away estimate instead of `null` if it recurs — not yet re-tested, and no stuck-value
heuristic has been added to catch it (deliberately — a legitimately slowly-decrementing minutes
value can look flat over a single 15-30s poll window, so a naive "flat for N ticks" check would
misfire on normal data).

### Images (`coverImage` / `liveSnapshot`)

Bambuddy: `POST /api/v1/printers/camera/stream-token` mints a short-lived token, then
`GET /{id}/cover?token=...` (plate-preview render, static per job) and
`GET /{id}/camera/snapshot?token=...` (live camera frame). `coverImage` is fetched once per print
and cached on `activityTokenStore`'s per-printer record (checked before ever re-fetching);
`liveSnapshot` is fetched fresh on every update (meant to look "live"), never on push-to-start
(would spend a stream-token mint on an image discarded unused).

**Hard budget constraint**: ActivityKit's real budget for the whole serialized content-state is
close to 4KB, and a `Data` field costs ~33% more once base64-encoded. Going over doesn't fail
gracefully — the system **ends the Live Activity outright** rather than dropping just that update.
`imageDownscale.js` matches the app's own downscale algorithm exactly (not approximated):

| Field | maxDimension | maxBytes |
|---|---|---|
| `coverImage` | 36pt | 1000 |
| `liveSnapshot` | 40pt | 1300 |

Algorithm: `scale = min(maxDimension / max(width, height), 1)` (never upscale) → resize at a render
scale of 1 (no device-scale multiplier to fight in Node, unlike the Swift side's
`UIGraphicsImageRenderer` pitfall) → encode JPEG at quality 0.5 → while over `maxBytes` and quality
> 0.1, reduce quality by 0.1 and re-encode → if still over budget at the quality floor, omit the
image for that update entirely rather than exceeding the cap. Verified `sharp` actually works at
runtime inside the real `node:20-alpine` (musl) Docker build, not just `npm install` succeeding.
Measured worst case (both images at their exact byte caps, plus a real ~54-char `jobName`): 3389
bytes total, comfortably under budget.

## Payload shapes

All three payload builders live in `payload.js`.

**Push-to-start** (`aps.event: "start"`):
```json
{
  "aps": {
    "timestamp": "<unix seconds>",
    "event": "start",
    "content-state": { /* see below */ },
    "attributes-type": "PrintActivityAttributes",
    "attributes": { "printerID": "<normalizedID>", "printerName": "<parsed name>" },
    "alert": { "title": "Print Started", "body": "<printerName> is printing" }
  }
}
```

**Activity update/end** (`aps.event: "update" | "end"`, no `attributes-type`/`attributes`/`alert` —
those are only meaningful when creating an activity):
```json
{
  "aps": {
    "timestamp": "<unix seconds>",
    "event": "update | end",
    "content-state": { /* see below */ },
    "dismissal-date": "<unix seconds, present only on \"end\">"
  }
}
```

**content-state** (identical shape for all three event types):
```json
{
  "progress": 0,
  "stateLabel": "Printing",
  "jobName": null,
  "startedAt": "<Apple reference-date seconds>",
  "estimatedEndAt": null,
  "currentLayer": null,
  "totalLayers": null,
  "nozzleTempC": null,
  "bedTempC": null,
  "coverImage": null,
  "liveSnapshot": null,
  "issueSeverity": null,
  "issueCount": null
}
```

**Background wake** (plain `content-available`, sent as `pushType: 'background'` to the bundle ID
directly rather than the `.push-type.liveactivity` topic):
```json
{ "aps": { "content-available": 1 } }
```

### Date encoding — two different conventions, deliberately

- **`content-state`'s `startedAt`/`estimatedEndAt`**: Swift's *default* (uncustomized) `Codable`
  conformance for `Date`, which ActivityKit always uses regardless of what strategy the app's own
  decoders use elsewhere — a raw number via `timeIntervalSinceReferenceDate` (seconds since
  **2001-01-01**), not `timeIntervalSince1970` (Unix epoch) and not a string. An earlier version
  sent ISO8601 strings (type mismatch → silent decode failure, activity never created, zero error
  surfaced anywhere since APNs still 200s); the next attempt sent Unix-epoch seconds on the
  (still-wrong) assumption that `.deferredToDate` meant Unix time — a valid number, so it decoded
  without error, but produced a `Date` ~55 years off from reality. Fixed:
  `toAppleReferenceTimestamp()` subtracts the fixed 978307200-second offset.
- **`aps.timestamp` and `aps.dismissal-date`**: plain Unix epoch seconds. These are top-level `aps`
  keys read directly by APNs/the system, **not** Codable-decoded by the app's Swift struct, so
  running them through `toAppleReferenceTimestamp()` would repeat the same class of mistake, just
  inverted.

`dismissal-date` (end events only) tells the system to remove the ended activity from the Lock
Screen 5 minutes after the push, rather than Apple's ~4-hour default — a fallback for when the app
never reopens; NozzleCast also has its own local dismissal path that clears an ended activity
within ~30s on foreground regardless of this value.

## Error handling

- **ntfy connection drops**: reconnect with exponential backoff (1s → 30s cap), log each attempt.
- **APNs auth misconfiguration**: on startup, one lightweight APNs auth check per environment
  (sandbox and production each have their own key — see Configuration) so a bad deploy fails
  loudly in logs immediately rather than silently dropping every future push. Best-effort: never
  blocks startup on a hang (10s race against a timeout) or a network error (DNS not yet resolvable
  in a fresh container); only a definitive 403 (`BadEnvironmentKeyInToken` or similar) exits the
  process.
- **Per-token send failure**, for all three token stores: `400`/`410`
  (`BadDeviceToken`/`Unregistered`/etc.) removes/clears that entry; any other error (`500`,
  timeout, network) logs and leaves the token in place — the next trigger retries naturally, no
  dead-letter queue.
- **Malformed/unparseable ntfy message**: log and skip, never crash the watcher loop.
- **Single printer's Bambuddy fetch failure** (poll trigger): logged, that printer's tick is
  skipped — does not affect other printers or crash the poll loop.
- **No registered activity token for an update/end event**: not an error — logged and retries the
  background wake (see above), rather than a bare skip.

## Configuration

| Var | Purpose |
|---|---|
| `NTFY_SERVER` | Base URL of the ntfy server — internal Docker address, not a public NPM-proxied hostname |
| `NTFY_TOPIC` | Topic to subscribe to |
| `NTFY_AUTH_TOKEN` | ntfy auth token |
| `RELAY_AUTH_SECRET` | Bearer secret required on `/register`, `/register-device`, `/register-activity`, and their `DELETE` variants |
| `APNS_KEY_PATH` / `APNS_KEY_ID` | Mounted **production** `.p8` auth key path/ID |
| `APNS_SANDBOX_KEY_PATH` / `APNS_SANDBOX_KEY_ID` | Mounted **sandbox/development** `.p8` auth key path/ID — a separate key pair, not one shared across environments (confirmed: a production-scoped key's JWT got a 403 `BadEnvironmentKeyInToken` from the sandbox host, the same JWT got a normal 400 `BadDeviceToken` from production) |
| `APNS_TEAM_ID` | Apple Developer Team ID, shared by both keys |
| `APNS_BUNDLE_ID` | NozzleCast's bundle ID — the Live Activity topic is derived by appending `.push-type.liveactivity`; the background-wake push uses the bare bundle ID as its topic instead |
| `BAMBUDDY_URL` | Base URL of the Bambuddy instance |
| `BAMBUDDY_API_KEY` | Bambuddy API key — recommend a dedicated, read-only key (Bambuddy supports scoped keys independent of print-control/queue permissions); the relay never needs to control anything |
| `NTFY_TRIGGER_ENABLED` | Default `true`; exact `"false"` disables the ntfy trigger |
| `BAMBUDDY_POLL_TRIGGER_ENABLED` | Default `false`; exact `"true"` enables the Bambuddy-poll trigger |
| `BAMBUDDY_POLL_INTERVAL_MS` | Default `15000` — only relevant when polling is enabled |
| `LIVE_ACTIVITY_CORRECTION_INTERVAL_MS` | Default `600000` (10 min); this deploy runs `60000` (1 min) since real print jobs run ~9 minutes and the 10-minute default never fired at all |
| `DATA_DIR` | Default `/data` |
| `PORT` | Default `3000` |

**Compose gotcha**: `docker-compose.yml`'s `environment:` block only forwards vars explicitly
listed in it — `BAMBUDDY_POLL_INTERVAL_MS`/`LIVE_ACTIVITY_CORRECTION_INTERVAL_MS` being optional
with in-code defaults doesn't mean setting them in `.env` alone works; they were silently ignored
by Compose until added to that block explicitly.

## Testing

185/185 tests passing as of 2026-09-03. Unit tests for every pure module (title/state
classification, payload builders, enrichment mapping, image downscaling, JWT construction, all
three token stores) plus HTTP-level tests (supertest) for every endpoint including auth rejection.
`bambuddyPoller.test.js` covers the polling loop itself via a fake `bambuddyClient` and injectable
`now()` (no real timers): baseline-only first observation, every transition type, resume correctly
distinguished from a fresh start, new-vs-stale HMS codes, correction timing, and
`priorIssueSeverity`/`priorProgress` correctly reflecting the tick *before* a `FAILED` transition.
No CI / no automated integration test against production APNs — disproportionate for a
single-operator relay. One manual end-to-end smoke test per major change against real devices/real
prints remains how essentially every bug in this document was actually found — the real
Live-Activity-appears-and-updates-on-lock-screen behavior can't be meaningfully mocked.

### Replaying a real print lifecycle for widget testing (`scripts/replay-run.js`)

Rather than waiting for an actual print to test a widget change, `scripts/replay-run.js` sends
live APNs push-to-start/update/end traffic reconstructed from real logged print lifecycles (see
`scripts/replayRuns.js`) — real timestamps/progress/state transitions, synthetic-but-plausible
temps/layers (the relay's own logs never recorded full content-state, only progress and state
transitions). Uses a synthetic `printerID` (`test-replay-<run>`) that never collides with a real
Bambuddy printer, so it's safe to run alongside a real print on another printer. Run inside the
relay container so it shares the live `DATA_DIR`/env — it reads `tokens.json` directly to know
who to push-to-start, and polls `activity-tokens.json` to discover the per-activity token the app
registers via `/register-activity` (the live relay's own HTTP server handles that POST for real;
the script only reads the file, never touches the server):

```bash
docker compose exec nozzlecast-relay node scripts/replay-run.js --run sam-p1s-finish
docker compose exec nozzlecast-relay node scripts/replay-run.js --list
```

**This creates a real, visible Live Activity on every registered device** — not a mock, and it
sends the same background-wake push (retried every 15s while waiting, mirroring the real relay's
own correction-tick retry) that production does, so it behaves identically whether or not
NozzleCast is already foregrounded when the push-to-start lands. An earlier version of this
script forgot the wake push entirely — confirmed live: push-to-start rendered but every
subsequent update was skipped for the whole run, because nothing ever nudged the app into
observing the new activity and calling `/register-activity`.

Two runs
ship today: `sam-p1s-finish` (full happy-path RUNNING → FINISH climb to completion) and
`sam-p1s-paused-stopped` (RUNNING → PAUSE → FAILED-with-no-HMS-issue, exercising the "Paused" and
"Stopped" labels). `replayRuns.test.js` sanity-checks the run data itself (ordering, progress
range) but there's no meaningful way to unit test the script's live-APNs behavior — same reasoning
as every other real-device-only path in this document.

## Known limitations / open items

- Running both trigger sources simultaneously isn't guarded against — fine since this deploy runs
  only one at a time.
- Background wake retry (see above) has no cap on retry count/duration against a genuinely
  offline device for the length of a long print.
- `DELETE /register`/`DELETE /register-device` aren't wired into NozzleCast (no sign-out concept
  yet) — dead tokens are pruned reactively via APNs error responses instead.
- A print starting while the app happens to already be foreground could still produce a duplicate
  Live Activity card, since the NSE's own (foreground-only-effective) `Activity.request()` attempt
  was left in place as a comparison point. Not yet removed.
- The `remaining_time`-stuck-at-a-low-value case (see above) has no detection/mitigation beyond the
  near-completion-progress floor; a print hitting that specific pathological data pattern again
  would show a perpetually-near estimate rather than `null` or a corrected value.

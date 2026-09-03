# nozzlecast-relay: ActivityKit push-to-start relay

## Problem

NozzleCast shows a Live Activity for an in-progress print by parsing Bambuddy's ntfy
notifications in a Notification Service Extension (NSE) and calling `Activity.request()`. That
call only succeeds while the containing app is in the foreground — a hard ActivityKit
restriction (`ActivityAuthorizationError.visibility`). A print that starts while the phone is
locked (the common case) never gets a Live Activity until the app is next opened; `MonitorView`
catches it up on foreground/unlock, but there's a real gap between print start and that moment.

The only way to start a Live Activity purely from a push, with no app code running, is
ActivityKit's **push-to-start** mechanism: the app registers a push-to-start token, and a server
sends a specially-shaped APNs request carrying the activity's initial attributes/content-state.
This requires a component that can call APNs directly the moment Bambuddy reports a print
starting — something the existing ntfy → Firebase → NSE pipeline cannot do, since push-to-start
notifications go straight to APNs and no app code (including the NSE) ever sees them.

**Post-implementation update (2026-09-02/03):** the same on-device unreliability turned out to
extend past just *starting* the activity. `Activity<PrintActivityAttributes>.activities` and
`.activityUpdates` never reliably surface a push-to-start-created activity to the app, NSE, or
widget extension either — confirmed across a full session of live testing, including after a
background-wake push explicitly intended to trigger that sync. So the relay's actual scope grew
from "fix the missing start" to "fix start, update, and end all together" — see the Architecture
and Data flow sections below, and the Non-goals update.

## Goals

- Close the "print started while locked" gap: a Live Activity should appear on the lock screen
  within a few seconds of Bambuddy reporting a print start, regardless of app/phone state.
- **(Added post-implementation)** Keep that Live Activity updating — progress, and ending on
  completion/failure/cancellation — with the same regardless-of-app/phone-state guarantee. Once
  it became clear no on-device mechanism could be trusted to do this, it became as core a goal as
  the original start-while-locked one.
- Self-hosted, single-operator: no NozzleCast-run backend — this is a personal relay the user
  deploys alongside their own Bambuddy/ntfy stack.
- Minimal moving parts: one Docker service, no external DB/queue.

## Non-goals

- Multi-tenant / SaaS operation. This relay is built for one operator's own printers and devices.
- ~~Replacing the existing ntfy → Firebase → NSE pipeline, which still handles updates,
  completion, and the in-app notification history — this relay only adds the missing *start*
  path.~~ **No longer accurate as of the per-activity-token work below**: the relay now also
  drives every update and the end-of-print push directly, since the NSE/app-driven path for
  those turned out to be just as unreliable as it was for start. The ntfy → Firebase → NSE
  pipeline still independently handles the in-app notification history and non-Live-Activity
  push notifications — that part is untouched.
- Removing the NSE's existing (foreground-only-effective) `Activity.request()` attempt. Left in
  place for now as a comparison point while the relay is being validated; a known, accepted
  consequence is that if a print starts while the app happens to already be foreground, both the
  NSE and the relay's push-to-start could independently start a Live Activity, producing a
  duplicate card. To be removed once the relay is confirmed working (see Open questions).

## Architecture

Single Node.js service (`nozzlecast-relay`), one process, four internal pieces:

1. **ntfy watcher** — persistent SSE connection to `GET {NTFY_SERVER}/{NTFY_TOPIC}/sse`,
   authenticated with `NTFY_AUTH_TOKEN` (same server/topic/token NozzleCast itself uses).
   Reconnects with exponential backoff (1s → 30s cap) on drop. No missed-message replay — if the
   relay is down when a print starts, that start is simply missed, matching the existing
   pipeline's own limitation.

   **Post-implementation update (2026-09-02):** `NTFY_SERVER` points at the ntfy container's
   internal Docker address (`http://ntfy:80`), not the public `https://ntfy.townsville.cc`
   hostname. The public hostname is proxied through this homelab's Nginx Proxy Manager, which
   buffers/stalls SSE streams by default (`proxy_buffering`) — confirmed directly: a request
   through NPM never delivered even ntfy's own immediate `open` handshake message, while the same
   request straight to the `ntfy` container succeeded instantly. Since the relay and `ntfy`
   already share the same internal `backend` Docker network, going direct sidesteps NPM entirely
   for this connection rather than reconfiguring a proxy host other unrelated services also use.

2. **Token stores** — three separate JSON files under `/data` (mounted volume, survives
   restarts/redeploys), one per kind of token the app can register:
   - `tokens.json` — ActivityKit push-to-start tokens, one entry per device:
     ```json
     { "token": "<hex>", "environment": "sandbox" | "production", "registeredAt": "<ISO8601>" }
     ```
   - `device-tokens.json` — plain APNs device tokens, same shape, used only for the
     background-wake push (see Data flow).
   - `activity-tokens.json` — **(added 2026-09-02/03)** per-activity push tokens, one entry per
     *printer* rather than per token (a printer only ever has one live activity at a time, and a
     fresh registration always fully replaces whatever was tracked for that printer):
     ```json
     {
       "printerID": "<normalizedID>",
       "printerName": "<parsed name, or null>",
       "startedAt": "<ISO8601, or null>",
       "token": "<hex, or null>",
       "environment": "sandbox" | "production" | null,
       "registeredAt": "<ISO8601, or null>"
     }
     ```
     `printerName`/`startedAt` are set independently of `token`/`environment`/`registeredAt`:
     the former come from the ntfy "Print Started" event, the latter from the app's
     `/register-activity` call, which normally arrives slightly *after* the ntfy event. Every
     activity update/end push has to carry ActivityKit's entire content-state (not a diff), so
     the original `startedAt` has to survive independently of whenever the token itself shows up.

   All three are loaded at startup and rewritten on every register/deregister/prune.

3. **HTTP API** (Express):
   - `POST /register` / `DELETE /register` — bearer-token protected (`RELAY_AUTH_SECRET`).
     Body `{ "token": string, "environment": "sandbox" | "production" }`. Upserts/removes by
     token value in `tokens.json`.
   - `POST /register-device` / `DELETE /register-device` — **(added 2026-09-02)** same shape and
     auth, against `device-tokens.json`. See Data flow → background wake.
   - `POST /register-activity` — **(added 2026-09-02/03)** same auth. Body
     `{ "token": string, "printerID": string, "environment": "sandbox" | "production" }`.
     Upserts into `activity-tokens.json`, keyed by `printerID` (re-normalized server-side through
     the same `normalizedID()` the relay uses internally, so a lookup always matches even if the
     app forwards something other than the exact `attributes.printerID` it was given at start).
     No `DELETE /register-activity` — a stale token is superseded by the next print's
     registration, or cleared automatically on a dead-token APNs response (see Error handling).
   - `GET /healthz` — unauthenticated, for the Docker healthcheck.

4. **ntfy event classifier** — **(added 2026-09-02/03)** `parsing.js` now classifies an incoming
   title into one of three buckets, not just start-or-not:
   - `isStartEvent(title)`: contains `"start"` (unchanged from the original design).
   - `isProgressEvent(title)`: contains a percentage (`/\d+\s*%/`) — e.g. `"Print 50% Complete"`.
   - `isEndEvent(title)`: completion/failure/cancellation, deliberately conservative — a
     percentage title never counts (checked first), and bare `"complete"`/`"finish"` only counts
     when `"print"` also appears in the title, since Bambuddy sends other `"...Complete"` titles
     on this same topic that aren't print completions at all (e.g. `"Bed Cooldown Complete"`).
     `"fail"`/`"cancel"` don't need that guard — nothing else on this topic uses those words.

## Data flow

### Registration: push-to-start token (app → relay)

1. NozzleCast observes `Activity<PrintActivityAttributes>.pushToStartTokenUpdates` and gets a
   hex-encoded token whenever ActivityKit issues/rotates one.
2. App POSTs it to `/register` with the shared bearer secret, stored in the app the same way
   `PushSharedStore` already stores the ntfy config (Application Support / App Group).
3. On explicit sign-out/reset in NozzleCast Settings (if ever added), app calls `DELETE
   /register` — not required for v1 since APNs itself will report a dead token (see Error
   handling).

### Registration: device token for background wake (app → relay)

**(Added 2026-09-02.)** Even with push-to-start firing correctly, a push-to-start-created
activity never populated `Activity<PrintActivityAttributes>.activities` in any process — app,
NSE, or widget — until the app ran its own `PrintLiveActivityManager.sync` at least once;
confirmed against a real device, the activity appeared and sat frozen through every subsequent
push until the app was manually foregrounded once. So the app also registers its plain APNs
device token via `/register-device`, and the relay fires a `content-available` background push
to it alongside every push-to-start request, waking the app to run that sync without the user
opening it.

**Note:** this mechanism is still in place, but the per-activity-token work below (registration
+ trigger) is what the relay now relies on for progress/end pushes specifically, since it turned
out `activityUpdates` couldn't be trusted from the background-woken app either (see the root
cause note under Registration: per-activity token, below). Background-wake's continued role is
an open question — see Open questions.

### Registration: per-activity token (app → relay)

**(Added 2026-09-02/03.)** Root cause, confirmed across a full session of live testing: neither
`Activity<PrintActivityAttributes>.activities` nor `.activityUpdates` can be relied on from *any*
device-side code — foreground, NSE, or background-woken app — to find and update/end a
push-to-start-created activity. This isn't a timing bug fixable with a longer wait or a retry;
it's a platform limitation. The one thing Apple's docs guarantee is that the system wakes the app
specifically to deliver that *specific activity's own* push token, via
`Activity<T>.activityUpdates -> activity.pushTokenUpdates`. So:

1. The app observes every activity's own `pushTokenUpdates` stream and, on receiving a token,
   POSTs it to `/register-activity` with `{ token, printerID, environment }` — `printerID` is the
   same value the app received in the push-to-start payload's `attributes.printerID`.
2. This fully replaces whatever was tracked for that printer (see Architecture → token stores).
3. The app needs to have run at least once, before the *next* print starts, so it's already
   observing `activityUpdates` when push-to-start fires and the activity is created.

### Trigger: start (ntfy → push-to-start)

1. ntfy watcher receives a message matching `isStartEvent`.
2. `printerName(message)` / `normalizedID(name)` extract the printer identity (text before the
   first `:` in the message body, trimmed; then lowercased letters/digits only).
3. The relay records this print's start in `activity-tokens.json` (`startPrint()`), resetting any
   token left over from a previous print for this printer, since a new print is a new activity.
4. Builds the content-state and attributes objects, matching `PrintActivityAttributes` and its
   `ContentState`'s Swift `Codable` key names exactly (camelCase, matching the Swift property
   names verbatim — Swift's synthesized `Codable` uses the property name as the JSON key by
   default, and neither struct defines custom `CodingKeys`, so no name translation is needed):
   ```json
   {
     "progress": 0,
     "stateLabel": "Printing",
     "jobName": null,
     "startedAt": <Foundation reference-date seconds, see note below>,
     "estimatedEndAt": null,
     "currentLayer": null,
     "totalLayers": null,
     "nozzleTempC": null,
     "bedTempC": null,
     "coverImage": null,
     "liveSnapshot": null
   }
   ```
   **Post-implementation update (2026-09-02), two iterations:** the original design's assumption
   that `Date` fields should be ISO8601 strings, matching `.iso8601`, was wrong — ActivityKit
   decodes a pushed content-state with Swift's *default* (uncustomized) `Date` `Codable`
   conformance regardless of what strategy the app's own decoders use elsewhere, and a string is
   a type mismatch that fails silently (APNs accepts and delivers the push; the device just can't
   construct `ContentState` from it, so the activity is never created, with zero error surfaced
   anywhere). The first fix sent Unix-epoch seconds instead, on the further-wrong assumption that
   `.deferredToDate` meant Unix time — it actually means `timeIntervalSinceReferenceDate`
   (seconds since 2001-01-01, *not* 1970-01-01). That's still a valid number so it decoded
   without error, but produced a `Date` ~55 years off from reality. Both `startedAt` and
   `estimatedEndAt` are now encoded as `unixSeconds - 978307200` (the fixed offset between the
   two epochs).
5. For each registered push-to-start token, sends an HTTP/2 POST to
   `https://api.push.apple.com/3/device/<token>` (or `api.sandbox.push.apple.com` per that
   token's stored `environment`) with:
   - `apns-push-type: liveactivity`
   - `apns-topic: com.victormanuel.NozzleCast.push-type.liveactivity`
   - `apns-priority: 10`
   - `authorization: bearer <JWT>` — ES256, signed with the mounted `.p8` key, `kid` = Key ID,
     `iss` = Team ID, `iat` = now. Cached and reused for ~20 minutes per Apple's guidance rather
     than regenerated per request.
   - Body:
     ```json
     {
       "aps": {
         "timestamp": <unix seconds>,
         "event": "start",
         "content-state": { /* from step 4 */ },
         "attributes-type": "PrintActivityAttributes",
         "attributes": { "printerID": "<normalizedID>", "printerName": "<parsed name>" },
         "alert": { "title": "Print Started", "body": "<printerName> is printing" }
       }
     }
     ```
6. Also sends the background-wake `content-available` push to every registered device token (see
   Registration: device token, above).

### Trigger: progress/end (ntfy → activity update/end)

**(Added 2026-09-02/03.)** For a message matching `isProgressEvent` or `isEndEvent`:

1. Look up `activity-tokens.json` by the message's `normalizedID`. If there's no token registered
   for that printer yet (the app hasn't caught up, or was never running), log and skip — there's
   nothing to push to.
2. Build the content-state the same way as start (same field set, same reference-date timestamp
   encoding), but reusing the *tracked* `startedAt` from `startPrint()` rather than "now" — the
   print's real start time doesn't change mid-print, and every push has to carry the complete
   content-state, not a diff. `progress` comes from the title's percentage (or `1` for an end
   event); `stateLabel` is `"Printing"` for an update, or `"Failed"`/`"Cancelled"`/`"Complete"`
   for an end event depending on which keyword matched.
3. Sends to the same `apns-topic`/`apns-push-type` as push-to-start (Apple doesn't distinguish
   these by push-type header, only by `aps.event`), but with **no**
   `attributes-type`/`attributes`/`alert` — those are only meaningful when an activity is being
   created:
   ```json
   {
     "aps": {
       "timestamp": <unix seconds>,
       "event": "update" | "end",
       "content-state": { /* progress/stateLabel/startedAt as above */ }
     }
   }
   ```

## Error handling

- **ntfy connection drops**: reconnect with exponential backoff (1s → 30s cap), log each attempt
  and each successful reconnect (see the NPM-buffering note under Architecture for why this used
  to fire on a ~5-minute cycle even when nothing was actually wrong with the relay itself).
- **APNs auth misconfiguration** (bad key/kid/team id): on startup, perform one lightweight APNs
  auth check **per environment** (sandbox and production each have their own key — see
  Configuration) so a bad deploy fails loudly in `docker logs` immediately rather than silently
  dropping every future push.
- **Per-token send failure**, for all three token stores (push-to-start, device, activity):
  - `400`/`410` (`BadDeviceToken`, `Unregistered`, etc.) → remove/clear that entry.
  - Any other error (`500`, timeout, network) → log and leave the token in place; the next
    trigger retries naturally. No dead-letter queue or retry scheduler — not justified at this
    volume (single operator, at most a handful of print-starts per day).
- **Malformed/unparseable ntfy message**: log and skip; never crash the watcher loop.
- **No registered activity token for a progress/end event**: log and skip (see Trigger:
  progress/end, step 1) — not an error, just means the app hasn't registered for this print yet.

## Configuration

Environment variables:

| Var | Purpose |
|---|---|
| `NTFY_SERVER` | Base URL of the ntfy server — the internal Docker address (`http://ntfy:80`), not the public NPM-proxied hostname; see Architecture |
| `NTFY_TOPIC` | Topic to subscribe to |
| `NTFY_AUTH_TOKEN` | ntfy auth token |
| `RELAY_AUTH_SECRET` | Bearer secret required on `/register`, `/register-device`, `/register-activity`, and their `DELETE` variants |
| `APNS_KEY_PATH` | Path to the mounted **production** `.p8` auth key |
| `APNS_KEY_ID` | Production APNs auth key ID |
| `APNS_SANDBOX_KEY_PATH` | Path to the mounted **sandbox/development** `.p8` auth key |
| `APNS_SANDBOX_KEY_ID` | Sandbox APNs auth key ID |
| `APNS_TEAM_ID` | Apple Developer Team ID (`89863526TH`), shared by both keys |
| `APNS_BUNDLE_ID` | `com.victormanuel.NozzleCast` (push-to-start/update/end topic is derived by appending `.push-type.liveactivity`; the background-wake push uses the bare bundle ID as its topic instead) |

**Post-implementation update (2026-09-02):** the original design assumed one APNs auth key
covers both environments, per Apple's general documentation. Confirmed against a real deploy that
this doesn't hold universally: a production-scoped key's JWT was rejected with a 403
`BadEnvironmentKeyInToken` (an auth-tier error, not a device-token-tier one like `BadDeviceToken`)
when presented to `api.sandbox.push.apple.com`, while the identical JWT sent to
`api.push.apple.com` succeeded (got the expected 400 `BadDeviceToken` for the startup check's fake
token). The relay now holds two `ApnsClient`/`ApnsAuthProvider` pairs, one per environment, and
selects between them per-token based on that token's stored `environment` at registration time.

Volume: `/data` (holds `tokens.json`, `device-tokens.json`, and `activity-tokens.json`).

## Testing

- Unit tests for the ntfy title classifiers (`isStartEvent`, `isProgressEvent`, `isEndEvent`,
  `progressFraction`, `endStateLabel`) and `printerName`/`normalizedID`, table-driven against real
  Bambuddy message samples (including the "Bed Cooldown Complete" false-positive case for
  `isEndEvent`) — kept behaviorally aligned with the Swift originals by hand, same reasoning as
  the project's other intentionally-duplicated small structural-match-only logic.
- Unit tests for all three payload builders (push-to-start, background-wake,
  activity-update/end), including the reference-date timestamp encoding.
- Unit tests for all three token stores, including `ActivityTokenStore`'s printerID-keyed
  replace-on-new-registration semantics.
- Unit test for JWT construction: verify the signed token decodes and its claims/header match
  Apple's documented ES256 format (`alg: ES256`, `kid`, `iss`, `iat`).
- HTTP-level tests (supertest) for every endpoint, including auth rejection and body validation.
- One manual end-to-end smoke test per major change against real devices/real prints (both
  sandbox- and production-signed NozzleCast builds) — the actual OS-level
  Live-Activity-appears-and-updates-on-lock-screen behavior can't be meaningfully mocked, and in
  practice is how every bug in this document was actually found.
- No CI / no automated integration test against production APNs — disproportionate for a
  single-operator relay with no CI system in place. (GitHub's Dependabot has flagged 2 moderate
  vulnerabilities on this repo as of 2026-09-02, not yet triaged.)
- 92/92 tests passing as of the per-activity-token change (2026-09-02/03).

## Open questions / follow-ups (not blocking)

- Once the per-activity-token update/end path is confirmed working end-to-end on a real print,
  remove the NSE's now-redundant `Activity.request()` start attempt (and its `NCDEBUG` logging)
  from `NozzleCastNSE/NotificationService.swift`, and update NozzleCast's own `ARCHITECTURE.md`
  to describe the relay as the actual mechanism instead of documenting the gap.
- Whether the background-wake push (`/register-device`) is still pulling its weight now that
  progress/end pushes go straight to a per-activity token: it may still matter for the initial
  `PrintLiveActivityManager.sync` right after start (so the app's own UI/state — outside the
  Live Activity itself — catches up promptly), but that's unconfirmed. Worth revisiting once the
  per-activity-token path has a few real prints' worth of confirmed behavior.
- `DELETE /register` on app-side sign-out isn't wired into NozzleCast in v1 (there's no
  sign-out concept yet) — dead tokens are pruned reactively via APNs error responses instead.
  Same applies to `/register-device`; `/register-activity` has no `DELETE` at all by design (see
  Architecture → HTTP API).

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

## Goals

- Close the "print started while locked" gap: a Live Activity should appear on the lock screen
  within a few seconds of Bambuddy reporting a print start, regardless of app/phone state.
- Self-hosted, single-operator: no NozzleCast-run backend — this is a personal relay the user
  deploys alongside their own Bambuddy/ntfy stack.
- Minimal moving parts: one Docker service, no external DB/queue.

## Non-goals

- Multi-tenant / SaaS operation. This relay is built for one operator's own printers and devices.
- Replacing the existing ntfy → Firebase → NSE pipeline, which still handles updates, completion,
  and the in-app notification history — this relay only adds the missing *start* path.
- Removing the NSE's existing (foreground-only-effective) `Activity.request()` attempt. Left in
  place for now as a comparison point while the relay is being validated; a known, accepted
  consequence is that if a print starts while the app happens to already be foreground, both the
  NSE and the relay's push-to-start could independently start a Live Activity, producing a
  duplicate card. To be removed once the relay is confirmed working.

## Architecture

Single Node.js service (`nozzlecast-relay`), one process, three internal pieces:

1. **ntfy watcher** — persistent connection to `GET {NTFY_SERVER}/{NTFY_TOPIC}/sse`, authenticated
   with `NTFY_AUTH_TOKEN` (same server/topic/token NozzleCast itself uses). Reconnects with
   exponential backoff (1s → 30s cap) on drop. No missed-message replay — if the relay is down
   when a print starts, that start is simply missed, matching the existing pipeline's own
   limitation.
2. **Token store** — a JSON file at `/data/tokens.json` (mounted volume, survives
   restarts/redeploys). One entry per registered device:
   ```json
   { "token": "<hex>", "environment": "sandbox" | "production", "registeredAt": "<ISO8601>" }
   ```
   Loaded at startup, rewritten on every register/deregister/prune.
3. **HTTP API** (Express):
   - `POST /register` — bearer-token protected (`RELAY_AUTH_SECRET`). Body `{ "token": string,
     "environment": "sandbox" | "production" }`. Upserts by token value.
   - `DELETE /register` — same auth, body `{ "token": string }`. Removes an entry.
   - `GET /healthz` — unauthenticated, for the Docker healthcheck.

## Data flow

### Registration (app → relay, on token change)

1. NozzleCast observes `Activity<PrintActivityAttributes>.pushToStartTokenUpdates` (new Swift
   code, app target) and gets a hex-encoded token whenever ActivityKit issues/rotates one.
2. App POSTs it to `/register` with the shared bearer secret, stored in the app the same way
   `PushSharedStore` already stores the ntfy config (Application Support / App Group).
3. On explicit sign-out/reset in NozzleCast Settings (if ever added), app calls `DELETE
   /register` — not required for v1 since APNs itself will report a dead token (see Error
   handling).

### Trigger (ntfy message → push-to-start)

1. ntfy watcher receives a message. Applies the same parsing logic already in
   `NotificationService.swift`, ported to JS and kept in sync by hand (same reasoning as the
   project's existing duplicated Swift files — small, stable, structural-match-only logic):
   - `isStartEvent(title)`: title (lowercased) contains `"start"`.
   - `printerName(message)`: text before the first `:` in the message body, trimmed.
   - `normalizedID(name)`: lowercased, letters/digits only.
2. Builds the content-state and attributes objects, matching `PrintActivityAttributes` and its
   `ContentState`'s Swift `Codable` key names exactly (camelCase, matching the Swift property
   names verbatim — Swift's synthesized `Codable` uses the property name as the JSON key by
   default, and neither struct defines custom `CodingKeys`, so no name translation is needed):
   ```json
   {
     "progress": 0,
     "stateLabel": "Printing",
     "jobName": null,
     "startedAt": "<ISO8601>",
     "estimatedEndAt": null,
     "currentLayer": null,
     "totalLayers": null,
     "nozzleTempC": null,
     "bedTempC": null,
     "coverImage": null,
     "liveSnapshot": null
   }
   ```
   `Date` fields use ISO8601 strings; this must match whatever `JSONDecoder` date strategy
   ActivityKit uses for push-to-start payloads (`.iso8601`, per Apple's ActivityKit push
   notification docs) — verified during implementation against a real payload, not assumed.
3. For each registered token, sends an HTTP/2 POST to `https://api.push.apple.com/3/device/<token>`
   (or `api.sandbox.push.apple.com` per that token's stored `environment`) with:
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
         "content-state": { /* from step 2 */ },
         "attributes-type": "PrintActivityAttributes",
         "attributes": { "printerID": "<normalizedID>", "printerName": "<parsed name>" },
         "alert": { "title": "Print Started", "body": "<printerName> is printing" }
       }
     }
     ```

## Error handling

- **ntfy connection drops**: reconnect with exponential backoff (1s → 30s cap), log each attempt
  and each successful reconnect.
- **APNs auth misconfiguration** (bad key/kid/team id): on startup, perform one lightweight APNs
  auth check so a bad deploy fails loudly in `docker logs` immediately rather than silently
  dropping every future push.
- **Per-token send failure**:
  - `400`/`410` (`BadDeviceToken`, `Unregistered`, etc.) → remove that token from the store.
  - Any other error (`500`, timeout, network) → log and leave the token in place; the next
    trigger retries naturally. No dead-letter queue or retry scheduler — not justified at this
    volume (single operator, at most a handful of print-starts per day).
- **Malformed/unparseable ntfy message**: log and skip; never crash the watcher loop.

## Configuration

Environment variables:

| Var | Purpose |
|---|---|
| `NTFY_SERVER` | Base URL of the ntfy server |
| `NTFY_TOPIC` | Topic to subscribe to |
| `NTFY_AUTH_TOKEN` | ntfy auth token |
| `RELAY_AUTH_SECRET` | Bearer secret required on `/register` and `DELETE /register` |
| `APNS_KEY_PATH` | Path to the mounted **production** `.p8` auth key |
| `APNS_KEY_ID` | Production APNs auth key ID |
| `APNS_SANDBOX_KEY_PATH` | Path to the mounted **sandbox/development** `.p8` auth key |
| `APNS_SANDBOX_KEY_ID` | Sandbox APNs auth key ID |
| `APNS_TEAM_ID` | Apple Developer Team ID (`89863526TH`), shared by both keys |
| `APNS_BUNDLE_ID` | `com.victormanuel.NozzleCast` (topic is derived by appending
  `.push-type.liveactivity`) |

**Post-implementation update (2026-09-02):** the original design assumed one APNs auth key
covers both environments, per Apple's general documentation. Confirmed against a real deploy that
this doesn't hold universally: a production-scoped key's JWT was rejected with a 403
`BadEnvironmentKeyInToken` (an auth-tier error, not a device-token-tier one like `BadDeviceToken`)
when presented to `api.sandbox.push.apple.com`, while the identical JWT sent to
`api.push.apple.com` succeeded (got the expected 400 `BadDeviceToken` for the startup check's fake
token). The relay now holds two `ApnsClient`/`ApnsAuthProvider` pairs, one per environment, and
selects between them per-token based on that token's stored `environment` at registration time.

Volume: `/data` (holds `tokens.json`).

## Testing

- Unit tests for the ported parsing logic (`isStartEvent`, `printerName`, `normalizedID`) and the
  APNs payload builder, table-driven against the same real Bambuddy message samples used to
  validate the Swift originals — keeps the two implementations behaviorally identical.
- Unit test for JWT construction: verify the signed token decodes and its claims/header match
  Apple's documented ES256 format (`alg: ES256`, `kid`, `iss`, `iat`).
- One manual end-to-end smoke test against the APNs **sandbox** environment (dev-signed
  NozzleCast build, real device, real print) before considering this done — the actual
  OS-level Live-Activity-appears-on-lock-screen behavior can't be meaningfully mocked.
- No CI / no automated integration test against production APNs — disproportionate for a
  single-operator relay with no CI system in place.

## Open questions / follow-ups (not blocking)

- Once this relay is confirmed working end-to-end, remove the NSE's now-redundant
  `Activity.request()` start attempt (and its `NCDEBUG` logging) from
  `NozzleCastNSE/NotificationService.swift`, and update `ARCHITECTURE.md` to describe the relay
  as the actual mechanism instead of documenting the gap.
- `DELETE /register` on app-side sign-out isn't wired into NozzleCast in v1 (there's no
  sign-out concept yet) — dead tokens are pruned reactively via APNs error responses instead.

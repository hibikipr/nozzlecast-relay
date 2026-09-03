# nozzlecast-relay

ActivityKit push-to-start relay for [NozzleCast](https://github.com/hibikipr/NozzleCast). Watches
Bambuddy's ntfy topic directly and fires an APNs push-to-start request the moment a print starts,
so NozzleCast's Live Activity appears even while the phone is locked — something the app's own
Notification Service Extension cannot do (`Activity.request()` only succeeds while the app is
foreground; see NozzleCast's `ARCHITECTURE.md`).

Design: [docs/superpowers/specs/2026-09-02-push-to-start-relay-design.md](docs/superpowers/specs/2026-09-02-push-to-start-relay-design.md)

## Configuration

| Var | Purpose |
|---|---|
| `NTFY_SERVER` | Base URL of the ntfy server |
| `NTFY_TOPIC` | Topic to subscribe to |
| `NTFY_AUTH_TOKEN` | ntfy auth token |
| `RELAY_AUTH_SECRET` | Bearer secret required on `/register` and `DELETE /register` |
| `APNS_KEY_PATH` | Path to the mounted **production** Apple `.p8` auth key |
| `APNS_KEY_ID` | Production APNs auth key ID |
| `APNS_SANDBOX_KEY_PATH` | Path to the mounted **sandbox/development** Apple `.p8` auth key |
| `APNS_SANDBOX_KEY_ID` | Sandbox APNs auth key ID |
| `APNS_TEAM_ID` | Apple Developer Team ID (shared by both keys) |
| `APNS_BUNDLE_ID` | NozzleCast's bundle ID (relay derives the APNs topic by appending `.push-type.liveactivity`) |
| `DATA_DIR` | Optional, defaults to `/data` |
| `PORT` | Optional, defaults to `3000` |

Two separate `.p8` keys are required, not one. Apple APNs auth keys are usually
environment-agnostic, but this was confirmed *not* to hold for at least one real key pair: a
production-scoped key's JWT got a 403 `BadEnvironmentKeyInToken` from the sandbox APNs host,
while the same JWT sent to the production host got a normal 400 `BadDeviceToken`. Create both a
Production and a Development/Sandbox APNs auth key in your Apple Developer account if you don't
already have both, and point the relay at each.

## Running locally

```bash
npm install
npm test
NTFY_SERVER=... NTFY_TOPIC=... NTFY_AUTH_TOKEN=... RELAY_AUTH_SECRET=... \
  APNS_KEY_PATH=... APNS_KEY_ID=... APNS_SANDBOX_KEY_PATH=... APNS_SANDBOX_KEY_ID=... \
  APNS_TEAM_ID=... APNS_BUNDLE_ID=... \
  npm start
```

## Deploying

Copy `docker-compose.example.yml` to `docker-compose.yml`, put your Apple `.p8` keys at
`./secrets/AuthKey.p8` (production) and `./secrets/AuthKey-Sandbox.p8` (sandbox), fill in `.env`
(copy from `.env.example`), then:

```bash
docker compose up -d --build
```

## API

- `POST /register` — body `{ "token": string, "environment": "sandbox" | "production" }`,
  `Authorization: Bearer <RELAY_AUTH_SECRET>`. Registers an ActivityKit push-to-start token.
- `DELETE /register` — body `{ "token": string }`, same auth.
- `POST /register-device` / `DELETE /register-device` — same shape and auth as `/register`, but
  for NozzleCast's plain APNs device token rather than a Live Activity push-to-start token. On
  every print-start event the relay also sends a `content-available` background push to each
  registered device token, waking the app so its own `PrintLiveActivityManager.sync` runs — the
  only thing that makes a push-to-start-created activity visible/updatable anywhere (app, NSE, or
  widget extension all query `Activity<PrintActivityAttributes>.activities`, which otherwise stays
  empty for an activity the app itself never ran code for). See NozzleCast's `ARCHITECTURE.md`.
- `POST /register-activity` — body `{ "token": string, "printerID": string, "environment": "sandbox" | "production" }`,
  same auth. Registers the *activity's own* per-activity push token (from
  `Activity<PrintActivityAttributes>.activityUpdates` → `activity.pushTokenUpdates` on the app
  side), keyed by printerID rather than by token — a printer only ever has one live activity at a
  time, and each new print's registration fully replaces whatever token was stored for that
  printer. Once registered, the relay sends progress/completion updates directly to this token as
  Bambuddy reports them (`event: "update"` for a percentage-progress notification, `event: "end"`
  for a completion/failure/cancellation one), rather than depending on the app, NSE, or widget
  ever running again after the initial push-to-start — see the design spec for why that dependency
  doesn't hold up in practice. `printerID` should be the same value the app received in the
  push-to-start payload's `attributes.printerID` (the relay re-normalizes it the same way
  regardless, so an exact match isn't required).
- `GET /healthz` — unauthenticated.

# nozzlecast-relay

ActivityKit push-to-start relay for [NozzleCast](https://github.com/hibikipr/NozzleCast). Watches
for a print starting — by polling Bambuddy's own API and diffing `gcode_state` — and fires an
APNs push-to-start request the moment it does, so NozzleCast's Live Activity
appears even while the phone is locked — something the app's own Notification Service Extension
cannot do (`Activity.request()` only succeeds while the app is foreground; see NozzleCast's
`ARCHITECTURE.md`). From there the relay also owns every progress/pause/error/end update for the
activity's whole lifetime, pushed directly to that activity's own per-activity APNs token — not
just the initial start.

Architecture: [ARCHITECTURE.md](ARCHITECTURE.md) — consolidated, current-state design reference
(modules, data flow, payload shapes, configuration, known limitations). The point-in-time design
docs it's consolidated from remain under `docs/superpowers/specs/` as the full investigation
history: [push-to-start relay](docs/superpowers/specs/2026-09-02-push-to-start-relay-design.md),
[Bambuddy API enrichment](docs/superpowers/specs/2026-09-03-bambuddy-enrichment-design.md),
[Live Activity images](docs/superpowers/specs/2026-09-03-live-activity-images-design.md),
[HMS severity badge](docs/superpowers/specs/2026-09-03-hms-severity-badge-design.md), and the
[Bambuddy-poll trigger](docs/superpowers/specs/2026-09-03-bambuddy-poll-trigger-design.md).

## Configuration

| Var | Purpose |
|---|---|
| `RELAY_AUTH_SECRET` | Bearer secret required on `/register` and `DELETE /register` |
| `APNS_KEY_PATH` | Path to the mounted **production** Apple `.p8` auth key |
| `APNS_KEY_ID` | Production APNs auth key ID |
| `APNS_SANDBOX_KEY_PATH` | Path to the mounted **sandbox/development** Apple `.p8` auth key |
| `APNS_SANDBOX_KEY_ID` | Sandbox APNs auth key ID |
| `APNS_TEAM_ID` | Apple Developer Team ID (shared by both keys) |
| `APNS_BUNDLE_ID` | NozzleCast's bundle ID (relay derives the APNs topic by appending `.push-type.liveactivity`) |
| `BAMBUDDY_URL` | Base URL of your Bambuddy instance |
| `BAMBUDDY_API_KEY` | Bambuddy API key. **Recommend a dedicated, read-only key** (Bambuddy supports scoped keys independent of print-control/queue permissions) — the relay only ever reads printer status to enrich a Live Activity, it never needs to control anything |
| `BAMBUDDY_POLL_INTERVAL_MS` | Optional, defaults to `15000` — how often Bambuddy is polled for `gcode_state` transitions |
| `LIVE_ACTIVITY_CORRECTION_INTERVAL_MS` | Optional, defaults to `600000` (10 min) — how often an active print with no other event gets a correction update to keep `estimatedEndAt` accurate |
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
RELAY_AUTH_SECRET=... \
  APNS_KEY_PATH=... APNS_KEY_ID=... APNS_SANDBOX_KEY_PATH=... APNS_SANDBOX_KEY_ID=... \
  APNS_TEAM_ID=... APNS_BUNDLE_ID=... \
  BAMBUDDY_URL=... BAMBUDDY_API_KEY=... \
  npm start
```

## Testing the Live Activity widget without a real print

`scripts/replay-run.js` replays a real logged print lifecycle as live APNs traffic against
whatever devices are currently registered — see [ARCHITECTURE.md](ARCHITECTURE.md#replaying-a-real-print-lifecycle-for-widget-testing-scriptsreplay-runjs).
Run it inside the deployed container so it shares the live token stores:

```bash
docker compose exec nozzlecast-relay node scripts/replay-run.js --list
docker compose exec nozzlecast-relay node scripts/replay-run.js --run sam-p1s-finish
```

This creates a real, visible Live Activity on every registered device — not a mock.

## Deploying

Copy `docker-compose.example.yml` to `docker-compose.yml`, put your Apple `.p8` keys at
`./secrets/AuthKey.p8` (production) and `./secrets/AuthKey-Sandbox.p8` (sandbox), fill in `.env`
(copy from `.env.example`), then:

```bash
docker compose up -d --build
```

### Prebuilt images

Each GitHub release publishes a multi-arch image to `ghcr.io/hibikipr/nozzlecast-relay`:

| Tag | Moves to |
|---|---|
| `latest` | the newest **stable** release only |
| `beta` | the newest prerelease |
| `1.0.0-beta5` (exact version) | never — pin to this for a reproducible deploy |
| `sha-<short sha>` | never — the exact commit that produced the build |

Every release so far has been a prerelease, so **`latest` does not move yet** — track `beta` (or
pin an exact version) until a stable release is cut. `latest` used to be applied to every beta and
every manual build, which made it meaningless as a stability signal.

## API

- `POST /register` — body `{ "token": string, "environment": "sandbox" | "production" }`,
  `Authorization: Bearer <RELAY_AUTH_SECRET>`. Registers an ActivityKit push-to-start token.
- `DELETE /register` — body `{ "token": string }`, same auth.
- `POST /register-device` / `DELETE /register-device` — same shape and auth as `/register`, but
  for NozzleCast's plain APNs device token rather than a Live Activity push-to-start token. On
  every print-start event the relay also sends a `content-available` background push to each
  registered device token, waking the app so its own `PrintLiveActivityManager.sync` runs — a
  secondary fallback that keeps a locally-created/backgrounded activity in sync, not the primary
  mechanism (that's `/register-activity` below). See NozzleCast's `ARCHITECTURE.md`. iOS's
  delivery of a background push is discretionary and can be delayed with no relay-visible signal
  — confirmed live when an H2C print's activity token took ~37.5 minutes to register because the
  one-shot wake at print-start was evidently delayed. So this wake is retried on every
  `update`/`end` attempt for as long as a printer's activity has no token registered yet
  (piggybacking on the poll trigger's correction-interval tick — see
  `LIVE_ACTIVITY_CORRECTION_INTERVAL_MS` above — while polling is enabled), not just sent once;
  it stops the moment `/register-activity` lands. Note this means a long print with a genuinely
  offline/unreachable device will get a wake retry on every correction tick for the print's
  entire duration — worth widening `LIVE_ACTIVITY_CORRECTION_INTERVAL_MS` if that turns out to
  be too chatty against APNs in practice.
- `POST /register-activity` — body `{ "token": string, "printerID": string, "environment": "sandbox" | "production" }`,
  same auth. Registers the *activity's own* per-activity push token (from
  `Activity<PrintActivityAttributes>.activityUpdates` → `activity.pushTokenUpdates` on the app
  side), keyed by printerID rather than by token — a printer only ever has one live activity at a
  time, and each new print's registration fully replaces whatever token was stored for that
  printer. Once registered, this is the token the relay pushes every `update`/`end` event to for
  that printer's whole print — triggered by real Bambuddy state transitions (start/pause/resume/
  finish/failed) and new HMS issues when polling is enabled, or by `LIVE_ACTIVITY_CORRECTION_INTERVAL_MS`
  otherwise, not by any particular progress percentage — rather than depending on the app, NSE, or
  widget ever running again after the initial push-to-start. `printerID` should be the same value
  the app received in the push-to-start payload's `attributes.printerID` (the relay re-normalizes
  it the same way regardless, so an exact match isn't required).
- `GET /healthz` — unauthenticated.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)

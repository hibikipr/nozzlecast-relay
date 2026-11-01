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
| `LIVE_ACTIVITY_CHANNELS` | Optional, defaults to off. `true` puts each print's Live Activities on an APNs broadcast channel (iOS 18+), so updates reach a device even when its app never ran to register a per-activity token (Low Power Mode, force-quit). Requires Broadcast enabled under Push Notifications for the App ID in the Apple Developer portal; without it each print falls back to per-activity tokens |
| `PRINTER_ACCESS_CODES` | Optional. Comma-separated `<serial or printer name>:<LAN access code>` pairs, e.g. `31B8AP610800367:12345678,Sam P1S:87654321`. With a printer's code, a cover Bambuddy can't find (an HTTPS-dispatched print, a job name with a `/`) is read straight off the printer over FTPS, and each print's cover is kept for print history in `DATA_DIR/archive-covers`. See [Cover image API](#cover-image-api) |
| `COVER_API_KEY` | Optional. A second key that `GET /cover` accepts besides `RELAY_AUTH_SECRET`, for a dashboard or display that shouldn't hold the secret that also registers push tokens |
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

Track `latest` for stable releases, or `beta` to test prereleases before they're cut as stable.
`latest` used to be applied to every beta and every manual build, which made it meaningless as a
stability signal.

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
  side), keyed by printerID and holding **one token per device** showing that print — every device
  running the app gets its own Live Activity for the same print, with its own independent
  ActivityKit token, so a second device registering joins the list rather than evicting the first.
  Only a new print (detected by the poller) clears it. Once registered, these are the tokens the
  relay pushes every `update`/`end` event to for that printer's whole print — triggered by real Bambuddy state transitions (start/pause/resume/
  finish/failed) and new HMS issues when polling is enabled, or by `LIVE_ACTIVITY_CORRECTION_INTERVAL_MS`
  otherwise, not by any particular progress percentage — rather than depending on the app, NSE, or
  widget ever running again after the initial push-to-start. `printerID` should be the same value
  the app received in the push-to-start payload's `attributes.printerID` (the relay re-normalizes
  it the same way regardless, so an exact match isn't required).
- `GET /healthz` — unauthenticated.
- `GET /cover/:printerID` — the current or last job's cover image. See below.

### Cover image API

`GET /cover/:printerID` returns the sliced plate's render (the image Bambuddy shows on a printer
card) for a printer's current or last job, for any client: NozzleCast, a web dashboard, a
microcontroller display. The Live Activity's `coverImage` comes from the same source.

- **Printer:** `printerID` is the printer's Bambuddy name in any spelling (`Vic H2C`, `vic-h2c`,
  `vich2c`) or its serial number.
- **Auth:** `RELAY_AUTH_SECRET` or `COVER_API_KEY`, as `Authorization: Bearer <key>` or, for a
  client that can't set headers, `?key=<key>`. A key in the URL can end up in proxy logs; prefer
  the header, and `COVER_API_KEY` for devices.
- **Where the image comes from:** Bambuddy's own `/cover` first. When Bambuddy has none and the
  printer has an entry in `PRINTER_ACCESS_CODES`, the relay reads the job's 3MF straight off the
  printer over FTPS (port 990) and takes the plate's render from it. That covers prints Bambuddy
  doesn't look for: HTTPS-dispatched prints, whose https:// download link Bambuddy reads as
  internal storage though the printer saves the file to its `/cache`, and job names with a `/`,
  which the printer stores as `2f` (H2 series) or `_` (P1S) (maziggy/bambuddy#3382). The container must reach the printer on TCP 990.
  A1-series printers, whose FTPS takes only a clear data channel, aren't supported on that path.
- **Query options:**

  | Option | Values |
  |---|---|
  | `width`, `height` | fit inside this box (1–2048), keeping the aspect ratio; never enlarged |
  | `format` | `png` (default), `jpeg` (baseline, for TJpgDec/JPEGDEC), `rgb565` (raw 16-bit little-endian pixels, no header) |
  | `quality` | JPEG quality 1–100, default 80 |
  | `bg` | `RRGGBB` the transparent background is flattened onto for `jpeg`/`rgb565`, default `000000`; or `auto` for NozzleCast's look in any format: trimmed to the model, on `1f2329` for a light model or `c4c9d1` for a dark one, and padded out to fill `width` × `height` when both are given |
  | `view` | `top` for the top-down plate view instead of the angled one |

- **Response headers:** `X-Image-Width` / `X-Image-Height` (the size actually sent, needed for
  `rgb565`), `X-Print-Job` (the job name, URL-encoded), `X-Cover-Source` (`bambuddy` or `printer`)
  and an `ETag`. Send it back as `If-None-Match` to poll cheaply: the answer is `304` until the job
  or the asked-for rendering changes.
- **Errors:** `404` with `{ "error": "<why>" }` when the printer is unknown, has no job, or no
  cover could be found; a failed lookup is retried after 30 s, backing off to 10 min for that job.
  `400` for a bad option.

```bash
curl -H "Authorization: Bearer $COVER_API_KEY" -o cover.jpg \
  "https://relay.example.com/cover/vic-h2c?width=240&height=240&format=jpeg"
```

### Archived prints: `GET /cover/archive/:archiveId`

A past print's cover by its Bambuddy archive id, for print history: a 256×256 JPEG of the model on
its contrast backdrop. For the prints Bambuddy archived without a thumbnail (it has none without the
job's 3MF). Same auth as `GET /cover`; `ETag`/`If-None-Match` as above.

- **Saved as the print runs:** while a printer prints, the relay saves its cover under the archive
  Bambuddy made for that print, in `DATA_DIR/archive-covers/<archiveId>.jpg` (tens of KB each, the
  oldest removed past 3000).
- **Older prints:** for an archive from before that, the relay reads the job's file off the
  printer once (with its `PRINTER_ACCESS_CODES` entry). A reprint under the same name overwrites
  the printer's file, so for an archive a newer print reused the name of, the file is only trusted
  when it's the same project printed plate by plate: a plate no newer same-name print used (the
  file has every plate's render), or the same plate when that print finished within 10% of the
  file's predicted time for it. Anything else, like a failed reprint or a generic name used for
  another model, stays without a cover.
- **Errors:** `404` when there's no cover (looked for again after a day), `400` for an id that isn't
  a positive whole number, `503` when covers aren't set up.

### Bambuddy alerts: `POST /bambuddy/alerts`

Bambuddy's alerts (print finished or failed, printer errors, maintenance due…) can come through
the relay instead of ntfy and Firebase. The relay pushes each one to every NozzleCast device that
registered with it, except the alerts that device muted. A muted alert never reaches the phone,
which NozzleCast can't do on its own: iOS only lets it blank a push, not drop it.

- **Setup in Bambuddy:** Settings → Notifications → add a **Webhook** provider. URL
  `https://<relay>/bambuddy/alerts`, payload format **generic** with the default field names
  (`title`, `message`), the relay's `RELAY_AUTH_SECRET` as its auth header, and the events you
  want. Send a test: once the relay has received one, NozzleCast stops taking alerts from ntfy and
  Firebase (`GET /alerts/status` says `active`), so nothing arrives twice. The ntfy provider can
  then be turned off.
- **Photos:** the webhook's camera photo is kept for six hours and fetched by the app's
  notification extension (`GET /alert-photo/:id`, relay secret).
- **Muting:** the app sends each device's muted alerts with `PUT /muted-alerts`
  (`{ token, alerts: [{ title, body }] }`, matched exactly), kept in `DATA_DIR/alerts.json`.
- **Missed alerts:** if the relay was down when Bambuddy sent an alert, Bambuddy logs that send as
  failed. The relay reads Bambuddy's notification log every 5 minutes and pushes those it missed,
  without their photo. It learns which provider is its own from the first alert delivered. This
  needs the relay's Bambuddy API key to have `notifications:read`; without it, missed alerts aren't
  caught up (logged once).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)

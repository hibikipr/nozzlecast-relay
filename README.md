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
| `APNS_KEY_PATH` | Path to the mounted Apple `.p8` auth key |
| `APNS_KEY_ID` | Apple APNs auth key ID |
| `APNS_TEAM_ID` | Apple Developer Team ID |
| `APNS_BUNDLE_ID` | NozzleCast's bundle ID (relay derives the APNs topic by appending `.push-type.liveactivity`) |
| `DATA_DIR` | Optional, defaults to `/data` |
| `PORT` | Optional, defaults to `3000` |

## Running locally

```bash
npm install
npm test
NTFY_SERVER=... NTFY_TOPIC=... NTFY_AUTH_TOKEN=... RELAY_AUTH_SECRET=... \
  APNS_KEY_PATH=... APNS_KEY_ID=... APNS_TEAM_ID=... APNS_BUNDLE_ID=... \
  npm start
```

## Deploying

Copy `docker-compose.example.yml` to `docker-compose.yml`, put your Apple `.p8` key at
`./secrets/AuthKey.p8`, fill in `.env` (copy from `.env.example`), then:

```bash
docker compose up -d --build
```

## API

- `POST /register` — body `{ "token": string, "environment": "sandbox" | "production" }`,
  `Authorization: Bearer <RELAY_AUTH_SECRET>`.
- `DELETE /register` — body `{ "token": string }`, same auth.
- `GET /healthz` — unauthenticated.

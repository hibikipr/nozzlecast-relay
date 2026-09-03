# Bambuddy API enrichment for richer Live Activities

**Status: implemented (2026-09-03), steps 1–5 and 7–8 of the Plan below.** `BambuddyClient`,
`PrinterIdCache`, and the pure `enrichmentFromStatus` mapping are in place; `sendPushToStart` and
`sendActivityUpdate` in `index.js` both call through a single fail-open `fetchEnrichment` helper
before building their payload, falling back to the old text-only fields (progress from the ntfy
title, everything else `null`) on any Bambuddy error. `progress`/`estimatedEndAt` prefer
Bambuddy's numbers over the ntfy-title-parsed fallback as specified. Step 6 (`coverImage`/
`liveSnapshot`) shipped as its own follow-up spec/implementation
(`2026-09-03-live-activity-images-design.md`).

**Post-implementation fix (2026-09-03), found via a real live test:** `nozzleTempC`/`bedTempC`
are declared `Int?` on the Swift side (`PrintActivityAttributes.ContentState`), but
`enrichmentFromStatus` was passing Bambuddy's raw fractional Doubles straight through (e.g.
`74.59375`). `JSONDecoder`'s default `Int` decoding does not truncate a fractional JSON number —
it throws a type-mismatch error — and since ActivityKit decodes the entire `content-state` as one
struct, that one field failing silently failed the *whole* push-to-start on-device, while APNs
itself kept returning a clean 200 throughout (Apple never validates a payload against the app's
actual Swift types, only that it's well-formed JSON). This is very likely why push-to-start
looked broken from the very first real end-to-end test of this enrichment pass, not anything
specific to the Bambuddy-poll trigger it was tested alongside. Fixed with `Math.round()` on both
fields rather than widening the Swift type, matching the app's existing Int-everywhere convention
for displayed temps.

## Problem

Every Live Activity field the relay controls today comes from parsing Bambuddy's ntfy alert
text (`title`/`message`), not from Bambuddy's own REST API — the same API NozzleCast's app uses
directly via `BambuddyAPIClient.swift`. Concretely, `payload.js`'s `buildContentState` sends:

- `progress` — parsed from a `"Print 50% Complete"`-style title via `parsing.js#progressFraction`
  (only present on progress/end events; always `0` at start).
- `jobName`, `currentLayer`, `totalLayers`, `nozzleTempC`, `bedTempC`, `coverImage`,
  `liveSnapshot` — **always `null`**. There's no source for any of them in an ntfy push.
- `estimatedEndAt` — accepted as a parameter by `buildActivityStatePayload` but never actually
  passed from `index.js` today, so it's always `null` too.

This is what "very basic Live Activities" refers to: the Live Activity UI has fields for all of
the above (`PrintActivityAttributes.ContentState` in `NozzleCastShared`, shared by app/NSE/widget)
but the relay — now the *only* thing that ever populates a push-to-start-created activity, per
`ARCHITECTURE.md`'s Live Activities section — has never had the data to fill them.

Bambuddy's `GET /api/v1/printers/{id}/status` returns all of it already: `progress` (0–100, the
app divides by 100 — see `AppStore.swift:318`), `layerNum`, `totalLayers`, `subtaskName`,
`remainingTime` (seconds), and `temperatures.nozzle`/`temperatures.bed`. The relay just isn't
calling it.

## No changes needed on the NozzleCast/app side

`PrintActivityAttributes.ContentState` already has every field this needs
(`NozzleCastShared/Sources/NozzleCastShared/PrintActivityAttributes.swift`). This is purely a
relay-side data-sourcing change — the relay just needs to fill in fields it currently leaves
`null`, using the exact same JSON keys it already sends.

## Plan

### 1. New relay config

- `BAMBUDDY_URL` — base URL of the user's Bambuddy instance (same shape as `NTFY_SERVER`: no
  trailing slash after normalization).
- `BAMBUDDY_API_KEY` — bearer token, same auth style as `BambuddyAPIClient.swift`
  (`Authorization: Bearer <key>`).

**Recommend a dedicated, read-only key**, not reuse of the app's own key. Confirmed Bambuddy
supports scoped API keys (`backend/app/models/api_key.py`: `can_read_status`,
`can_control_printer`, `can_queue`, etc. are independent booleans, and there's a built-in
"Read-only access to printers, archives, and queue" role — `backend/app/core/permissions.py`).
The relay only ever needs `PRINTERS_READ`/read-status; it should never hold a key that can
control printers, touch the queue, or manage inventory. This is Victor's call to make when he
issues the key, not something to default silently — flag it, don't just reuse the app's key.

Both required in `config.js`'s `REQUIRED_VARS`, documented in `README.md`'s config table and
`.env.example`.

### 2. New module: `src/bambuddyClient.js`

Minimal REST client, same style as `ntfyWatcher.js` (uses the global `fetch`, no new
dependency):

```js
class BambuddyClient {
  constructor({ baseUrl, apiKey, fetchImpl = fetch }) { ... }
  async printers() { ... }        // GET /api/v1/printers/  -> [{ id, name, model }]
  async status(printerId) { ... } // GET /api/v1/printers/{id}/status -> full status DTO
}
```

Mirror only the fields actually used (see step 4) — no need to model Bambuddy's full status
shape the way the Swift DTO does.

### 3. Printer name → Bambuddy printer id resolution

ntfy messages carry only a name (`parsing.js#printerName`); Bambuddy's `/status` endpoint needs
the numeric id. Add a small in-memory cache in `index.js` (or its own tiny module) that:

- Calls `bambuddyClient.printers()` lazily on first use, or eagerly at startup alongside the
  APNs auth check.
- Builds a `normalizedID(printer.name) -> printer.id` map, using the *exact same*
  `normalizedID()` from `parsing.js` so a name-vs-slug mismatch (the same problem printer
  matching already solves elsewhere) doesn't reappear here.
- Refreshes on a cache miss (a printer added after the relay started) rather than only once at
  startup, but doesn't need to poll continuously — printers don't get added mid-print.

### 4. Enrich `sendActivityUpdate` (and optionally `sendPushToStart`)

In `index.js`, before calling `buildActivityStatePayload`, resolve the printer id and fetch
`bambuddyClient.status(id)`. Map onto the existing `buildContentState` parameters:

| ContentState field | Bambuddy status field | Notes |
|---|---|---|
| `progress` | `status.progress / 100` | Prefer this over `parsing.js#progressFraction` — exact, not regex-parsed from title text. Keep the text-parsed value as the fallback (see step 5). |
| `jobName` | `status.subtaskName` | |
| `currentLayer` | `status.layerNum` | |
| `totalLayers` | `status.totalLayers` | |
| `nozzleTempC` | `status.temperatures.nozzle` | |
| `bedTempC` | `status.temperatures.bed` | |
| `estimatedEndAt` | `now + status.remainingTime` seconds | Currently never sent at all — `buildActivityStatePayload` already accepts it, `index.js` just needs to pass it. |

`stateLabel` and the `update` vs `end` choice should **stay driven by the ntfy title** as today
(`isProgressEvent`/`isEndEvent`), not by `status.state` — by the time a "Print Complete" ntfy
event fires, Bambuddy's live status may already show `state: "idle"`/similar, which would race
with detecting the *event* itself. Bambuddy's API is the source for *telemetry*, ntfy stays the
source for *event timing*.

### 5. Fail open, never block a push

Wrap the `bambuddyClient.status()` call the same way the existing code treats anything
best-effort: on error/timeout, fall back to the current text-only behavior (progress from
`parsing.js#progressFraction`, other fields stay `null`) rather than dropping the push entirely.
Same philosophy as the startup APNs auth check's `AUTH_CHECK_TIMEOUT_MS` race — a slow/unreachable
Bambuddy must never stall or crash an activity update.

### 6. Images — separate follow-up phase, not this one

`coverImage`/`liveSnapshot` are real fields but genuinely harder: Bambuddy's cover/camera-snapshot
endpoints need a stream token (`POST /api/v1/printers/camera/stream-token`) and the images then
need downscaling to fit ActivityKit's real budget — confirmed the hard way already, per
`ARCHITECTURE.md`: **the whole serialized `ContentState` must stay under ~4KB, a `Data` field
costs ~33% more once base64-encoded, and each image is capped under ~1.3KB** — a looser cap
previously caused the system to *end the Live Activity outright* rather than drop the update. The
app's own downscale logic (`downscaledCoverImage`/`downscaledThumbnail`, pinning
`UIGraphicsImageRenderer`'s `format.scale = 1` to avoid a 9x-oversized render) would need a Node
equivalent — realistically a new image-processing dependency (e.g. `sharp`), which this relay
currently has none of. Worth doing, but as its own follow-up once steps 1–5 are confirmed working
against a real print, not bundled into this change.

### 7. Tests

Match existing conventions: inject a fake `bambuddyClient` into `index.js`'s dependencies the
same way `apnsClients`/`tokenStore`/etc. already are, so the enrichment logic is unit-testable
without real HTTP (see how `apnsClient.test.js` fakes `connect`, or `server.test.js`'s
`freshStore()` pattern). Cover: successful enrichment maps all fields correctly; a failed/timed-out
Bambuddy call falls back to text-parsed progress and null extras without throwing; the printer-id
cache resolves a name via `normalizedID` correctly and refreshes on a miss.

### 8. Docs

Update `README.md`'s config table (new env vars) and this spec's own status once implemented —
same pattern as the `2026-09-02-push-to-start-relay-design.md` reconciliation commit.

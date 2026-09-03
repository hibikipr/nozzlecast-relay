# Live Activity images (coverImage / liveSnapshot)

Follow-up to `2026-09-03-bambuddy-enrichment-design.md` (implemented in `595d7f7`/`575beaf`) —
that pass deliberately scoped images out as "step 6, a separate follow-up." This is that
follow-up.

## What's still missing

`PrintActivityAttributes.ContentState` has two image fields, both still always `null` from the
relay: `coverImage` (the sliced-plate render, static for the whole job) and `liveSnapshot`
(Bambuddy's live camera frame, meant to refresh independently). Bambuddy has both:

- `POST /api/v1/printers/camera/stream-token` — mints a short-lived token (separate from the
  main API key; see `BambuddyAPIClient.swift`'s doc comment — "short-lived", not cacheable
  long-term).
- `GET /api/v1/printers/{id}/cover?token=...` — the plate-preview render.
- `GET /api/v1/printers/{id}/camera/snapshot?token=...` — a live camera frame.

## The hard constraint (already learned the expensive way once)

Per `ARCHITECTURE.md`: ActivityKit's real budget for the *whole* serialized `ContentState` is
close to 4KB, and a `Data` field costs ~33% more once base64-encoded on top of its raw byte
count. Going over doesn't fail gracefully — the system **ends the Live Activity outright**
rather than just dropping that one update. This is why the app's own image caps are as tight as
they are; match them exactly rather than re-deriving from scratch:

| Field | Source (Swift) | maxDimension | maxBytes |
|---|---|---|---|
| `coverImage` | `PrintLiveActivityManager.downscaledCoverImage` | 36pt | 1000 |
| `liveSnapshot` | `NotificationService.downscaledThumbnail` | 40pt | 1300 |

Both use the same algorithm, worth replicating exactly rather than approximating:

1. Compute `scale = min(maxDimension / max(width, height), 1)` — never upscale.
2. Resize to `(width*scale, height*scale)` **at a render scale of 1**, not the platform default.
   The Swift version's own comment explains why this matters: `UIGraphicsImageRenderer` defaults
   to the device's screen scale (2x/3x), so a "36pt" render was actually rasterizing up to 9x the
   intended pixel count — no amount of JPEG quality reduction could claw that back under budget.
   This was the *actual* root cause behind a chain of "raise the byte cap" attempts that didn't
   work. In `sharp` terms: this is just resizing to the real target pixel dimensions — there's no
   separate "device scale" concept to fight in Node, but call it out in the implementation so
   nobody re-derives a scaled-up default some other way (e.g. via a DPI/density option).
3. Encode as JPEG starting at quality 0.5.
4. While `size > maxBytes` and `quality > 0.1`, reduce quality by 0.1 and re-encode.
5. If still over budget at the quality floor, **send no image for that field this update** rather
   than exceeding the cap — the existing Swift guard fails closed for the same reason (a blown
   budget risks the whole activity, not just the image).

## Plan

### 1. New dependency: `sharp`

Standard choice for this in Node — resize + JPEG re-encode with quality control, prebuilt
binaries (no native build step needed at `npm ci` time). One thing to verify during
implementation: the Dockerfile's base image is `node:20-alpine` (musl libc), and `sharp` does
ship musl-compatible prebuilt binaries (`@img/sharp-libvips-linuxmusl-*`), but confirm
`npm ci --omit=dev` actually pulls the right optional platform dependency in the Alpine build
stage rather than silently falling back to a missing-binary error at runtime — worth a real
`docker compose up -d --build` test, not just local `npm test` on whatever OS you're developing
on.

### 2. Fetching strategy — different cadence per field

- **`coverImage`**: fetch once per print, right after `sendPushToStart` (or on the first
  `sendActivityUpdate` if that's simpler) — it's static for the whole job, exactly like the app's
  own `PrintLiveActivityManager.hasCoverImage` caching. Store the downscaled JPEG bytes
  (post-processing, not the raw fetch) in `ActivityTokenStore`'s per-printer record alongside
  `startedAt`, so every subsequent update reuses it without re-fetching or re-encoding. Clear it
  when the activity ends (`activityTokenStore.clearToken` or wherever start/end already resets
  per-printer state).
- **`liveSnapshot`**: fetch fresh on every `sendActivityUpdate` call (progress/end events) — this
  is the one meant to look "live." A stream token is short-lived, so mint one right before each
  fetch rather than caching it.
- Fold both into the existing `fetchEnrichment()` (the fail-open helper from the last pass) or a
  sibling helper with the same fail-open contract — see below.

### 3. Fail-open, same as the numeric enrichment

A failed/slow image fetch, a stream-token mint failure, or a `sharp` encode that can't hit budget
must **never** block the rest of the update — send the payload with that image field `null`
(or, for `coverImage`, whatever was last successfully cached) rather than dropping progress/temp
data too. Same philosophy `fetchEnrichment()` already established for the Bambuddy status call.

### 4. Total-payload budget, now with more populated fields

The numeric/text enrichment pass already fills `jobName` (can be a real string, e.g. "No AMS
Version - 0.16mm layer, 2 walls, 15% infill" — confirmed ~50+ chars from a live payload).
Sanity-check the full serialized `ContentState` size with both a real `jobName` string *and* an
image at its cap, not just the image alone in isolation — the 4KB ceiling is for everything
combined. If it's tight, the image caps above already have headroom baked in (per the app-side
comment: "the byte caps that remain now have real headroom rather than being load-bearing"), but
worth an explicit check against a real payload rather than assuming.

### 5. Tests

- `sharp`-based downscale helper: given a real test image, verify output respects `maxBytes` at
  the documented `maxDimension`, and verify the quality-reduction loop actually engages for an
  image that doesn't fit at quality 0.5.
- Fail-open behavior: a failing stream-token mint or fetch produces a payload with the image
  field omitted, not a thrown error / dropped update.
- `coverImage` caching: fetched once, not re-fetched on a second `sendActivityUpdate` for the
  same print.
- `liveSnapshot`: fetched on each `sendActivityUpdate` call (can assert the mock fetch call count
  matches the number of update calls).

### 6. Docs

Update this spec's status line once implemented, and README if any new config surfaces (shouldn't
need any beyond the existing `BAMBUDDY_URL`/`BAMBUDDY_API_KEY` from the last pass — same
credential, same base URL).

## Status

Not yet implemented — planning only, per Victor's request after seeing the numeric-enrichment
pass working end-to-end. Numeric/temp/layer fields (progress, jobName, currentLayer, totalLayers,
nozzleTempC, bedTempC, estimatedEndAt) are already live as of `575beaf`; this spec covers the two
remaining `null` fields, `coverImage` and `liveSnapshot`.

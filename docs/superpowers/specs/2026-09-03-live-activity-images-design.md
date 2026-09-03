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

**Implemented.** `imageDownscale.js` (the resize+quality-loop algorithm, matching the caps table
above exactly), `BambuddyClient.mintCameraStreamToken()/cover()/cameraSnapshot()`, and
`ActivityTokenStore.setCoverImage()`/the `coverImage` field on its per-printer record are all in
place. `index.js`'s `fetchEnrichment()` fetches+caches `coverImage` at most once per print
(checking the cache first) and fetches `liveSnapshot` fresh on every call where
`includeLiveSnapshot: true` is passed (only `sendActivityUpdate`, not `sendPushToStart`, per the
cadence above) — both fail open the same way the numeric fields already did.

**Post-implementation fix (2026-09-03), found via a real live test:** `fetchEnrichment()`
originally wrapped the numeric telemetry fetch (`status`/`enrichmentFromStatus`) and both image
fetches in one `try`/`catch`. Confirmed live: Bambuddy's camera endpoints are meaningfully less
reliable than its status endpoint — a `camera/snapshot` request returned a `503` mid-print, and
because that error propagated out of the single shared `try`, it discarded the *entire* already-
successful enrichment, not just the image field. The resulting push sent `progress: 0` and
`estimatedEndAt: null` for a print that Bambuddy's own status endpoint reported as well underway
and perfectly healthy at that exact moment — froze the Live Activity's percentage/countdown
display until whatever push happened to succeed next. Exact log evidence: `"Bambuddy enrichment
failed for printer... camera/snapshot... failed with status 503"` immediately followed by
`"Activity update sent for printer... (progress=0)"`, twice in the same print.

Fixed by splitting `fetchEnrichment()` into separate fail-open boundaries: the numeric-telemetry
fetch keeps its own `try`/`catch` (a failure there still means "nothing to send, return null" —
unchanged), but `coverImage` and `liveSnapshot` now each get their own `try`/`catch` around just
that fetch, defaulting only that one field to `null` on failure while the numeric fields already
successfully fetched moments earlier are preserved and sent as normal. An image-endpoint hiccup
now costs exactly one field, never the whole update.

**Confirmed fixed against a real test print (2026-09-03):** progress and the countdown both
updated correctly through the whole print, no recurrence of the frozen-0%/no-time symptom. This
was the full explanation — no further change to the `remaining_time` sanity threshold was needed.

Verified against the real API before writing any code: confirmed `POST /api/v1/printers/camera/
stream-token` returns `{"token": "..."}` and needs no separate Authorization header on the two
image endpoints (the stream token alone is sufficient); confirmed `cover` is a 512x512 PNG and
`camera/snapshot` a 1280x720 JPEG in practice. Verified `sharp` actually works at runtime inside
the real `node:20-alpine` Docker build (not just `npm install` succeeding) — a throwaway image
build + container run, not an assumption. Ran the real downloaded images through the downscale
algorithm before wiring anything up: both land comfortably under budget at quality 0.5 already
(343B for a 36x36 cover, 490B for a 40x23 snapshot). Also measured the worst case combined
payload per step 4's instruction (both images at their exact byte caps, plus a real ~54-char
`jobName` string observed live): 3389 bytes total, comfortably under the ~4KB ceiling.

127/127 tests pass (18 new: the image downscale algorithm, `BambuddyClient`'s new methods,
`ActivityTokenStore` cover-image caching, `payload.js` passthrough).

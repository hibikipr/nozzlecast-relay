// Failed coverImage attempts allowed per print before giving up on it. More than one, because a
// render can legitimately be missing for the first moments of a print; few enough that a job with
// no render stops costing a Bambuddy fetch (and a decode) on every update. See
// ActivityTokenStore.recordCoverImageFailure.
const MAX_COVER_IMAGE_ATTEMPTS = 3;

// How long a push waits for its cover before going out without it. Reading a 3MF off a P1S over
// FTPS took 8m45s on 2026-11-17, and the push-to-start (and every other printer's poll) waited the
// whole time behind it. The lookup keeps running after this; the cover service caches what it
// gets, so a later update (or the early correction) picks it up.
const COVER_WAIT_MS = 5000;

const TIMED_OUT = Symbol('timed out');

// Resolves to the promise's value, or TIMED_OUT if it hasn't settled within ms. Rejects as the
// promise does when it settles in time. The promise itself keeps running either way; a rejection
// after the deadline is swallowed here rather than surfacing as unhandled.
function settleWithin(promise, ms) {
  promise.catch(() => {});
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(resolve, ms, TIMED_OUT); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Returns this print's coverImage (base64) or null, fetching it only when it isn't cached and the
// print hasn't already used up its attempts. `fetchCover` returns the downscaled base64 string, or
// null when the render won't fit the byte budget even at the quality floor; either that or a
// thrown error (e.g. Bambuddy's 404 for a job with no cached render) counts as a failed attempt.
// A fetch still running after waitMs is not a failure: this update goes out without the cover and
// a later one asks again. Never throws: a missing cover only costs that one field, never the rest
// of the update.
async function resolveCoverImage({
  activityTokenStore, printerID, name, fetchCover, maxAttempts = MAX_COVER_IMAGE_ATTEMPTS, waitMs = COVER_WAIT_MS,
}) {
  const tracked = activityTokenStore.get(printerID);
  if (tracked?.coverImage) return tracked.coverImage;
  if ((tracked?.coverImageFailures ?? 0) >= maxAttempts) return null;

  let failure;
  try {
    const coverImage = await settleWithin(Promise.resolve().then(fetchCover), waitMs);
    if (coverImage === TIMED_OUT) {
      console.log(`coverImage for printer "${name}" still loading after ${waitMs / 1000}s, sending this update without it`);
      return null;
    }
    if (coverImage) {
      await activityTokenStore.setCoverImage(printerID, coverImage);
      return coverImage;
    }
    failure = 'still over the byte budget at the quality floor';
  } catch (error) {
    failure = error?.message ?? String(error);
  }

  const attempts = await activityTokenStore.recordCoverImageFailure(printerID);
  console.error(
    `coverImage unavailable for printer "${name}" (${failure}), sending this update without it -- attempt ${attempts}/${maxAttempts}`
    + (attempts >= maxAttempts ? ', not retrying for the rest of this print' : ''),
  );
  return null;
}

module.exports = { resolveCoverImage, settleWithin, TIMED_OUT, MAX_COVER_IMAGE_ATTEMPTS, COVER_WAIT_MS };

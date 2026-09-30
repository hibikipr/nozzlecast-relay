// Failed coverImage attempts allowed per print before giving up on it. More than one, because a
// render can legitimately be missing for the first moments of a print; few enough that a job with
// no render stops costing a Bambuddy fetch (and a decode) on every update. See
// ActivityTokenStore.recordCoverImageFailure.
const MAX_COVER_IMAGE_ATTEMPTS = 3;

// Returns this print's coverImage (base64) or null, fetching it only when it isn't cached and the
// print hasn't already used up its attempts. `fetchCover` returns the downscaled base64 string, or
// null when the render won't fit the byte budget even at the quality floor; either that or a
// thrown error (e.g. Bambuddy's 404 for a job with no cached render) counts as a failed attempt.
// Never throws: a missing cover only costs that one field, never the rest of the update.
async function resolveCoverImage({ activityTokenStore, printerID, name, fetchCover, maxAttempts = MAX_COVER_IMAGE_ATTEMPTS }) {
  const tracked = activityTokenStore.get(printerID);
  if (tracked?.coverImage) return tracked.coverImage;
  if ((tracked?.coverImageFailures ?? 0) >= maxAttempts) return null;

  let failure;
  try {
    const coverImage = await fetchCover();
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

module.exports = { resolveCoverImage, MAX_COVER_IMAGE_ATTEMPTS };

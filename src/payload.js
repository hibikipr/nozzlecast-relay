// Swift's default (uncustomized) Codable conformance for Date -- what ActivityKit always uses to
// decode a pushed content-state, per Apple's docs, regardless of any custom strategy the app's
// own decoders use elsewhere -- encodes/decodes a Date as a raw Double via
// `timeIntervalSinceReferenceDate` (seconds since 2001-01-01T00:00:00Z), NOT
// `timeIntervalSince1970` (Unix epoch) and NOT any string form. A previous version of this file
// sent Unix-epoch seconds here on the (incorrect) assumption that `.deferredToDate` meant Unix
// time; that's a real number so it wouldn't throw a decode error, but it silently produces a
// Date 55+ years off from reality. 978307200 is the fixed offset between the two epochs
// (2001-01-01 minus 1970-01-01, in seconds).
const APPLE_REFERENCE_DATE_UNIX_OFFSET = 978307200;

function toAppleReferenceTimestamp(date) {
  return Math.floor(date.getTime() / 1000) - APPLE_REFERENCE_DATE_UNIX_OFFSET;
}

// How long after an "end" push the system should keep the ended Live Activity visible before
// removing it from the Lock Screen, rather than Apple's own ~4-hour default. This is really only
// for the case where the app never gets reopened -- NozzleCast has its own local dismissal path
// (PrintLiveActivityManager.sync(), triggered on foreground) that clears an ended activity within
// ~30s regardless of this value.
const DISMISSAL_DELAY_MS = 5 * 60 * 1000;

// jobName/estimatedEndAt/currentLayer/totalLayers/nozzleTempC/bedTempC/coverImage/liveSnapshot
// all default to null -- a caller with no enrichment data (Bambuddy unreachable, printer not
// found, image over budget even at the quality floor, etc.) gets exactly the old text-only
// behavior for free by simply omitting them. coverImage/liveSnapshot, when provided, are
// expected to already be downscaled+budget-checked base64 JPEG strings (see
// imageDownscale.js) -- this function does no image processing of its own, it just passes
// through whatever base64 string it's given as ContentState's `Data` field (Swift's default
// Data Codable conformance is base64).
function buildContentState({
  startedAt,
  progress = 0,
  stateLabel = 'Printing',
  jobName = null,
  estimatedEndAt = null,
  currentLayer = null,
  totalLayers = null,
  nozzleTempC = null,
  bedTempC = null,
  coverImage = null,
  liveSnapshot = null,
  issueSeverity = null,
  issueCount = null,
}) {
  return {
    progress,
    stateLabel,
    jobName,
    startedAt: toAppleReferenceTimestamp(startedAt),
    estimatedEndAt: estimatedEndAt ? toAppleReferenceTimestamp(estimatedEndAt) : null,
    currentLayer,
    totalLayers,
    nozzleTempC,
    bedTempC,
    coverImage,
    liveSnapshot,
    issueSeverity,
    issueCount,
  };
}

function buildPushToStartPayload({
  printerID,
  printerName,
  now = new Date(),
  jobName = null,
  estimatedEndAt = null,
  currentLayer = null,
  totalLayers = null,
  nozzleTempC = null,
  bedTempC = null,
  coverImage = null,
  liveSnapshot = null,
  issueSeverity = null,
  issueCount = null,
}) {
  return {
    aps: {
      timestamp: Math.floor(now.getTime() / 1000),
      event: 'start',
      'content-state': buildContentState({
        startedAt: now, jobName, estimatedEndAt, currentLayer, totalLayers, nozzleTempC, bedTempC, coverImage, liveSnapshot, issueSeverity, issueCount,
      }),
      'attributes-type': 'PrintActivityAttributes',
      attributes: { printerID, printerName },
      alert: { title: 'Print Started', body: `${printerName} is printing` },
    },
  };
}

// Updates/ends an *existing* Live Activity via its own per-activity push token (not the
// push-to-start token) -- same apns-topic/apns-push-type as push-to-start (Apple doesn't
// distinguish these by push-type header, only by aps.event), but no attributes-type/attributes/
// alert: those are only meaningful when an activity is being created ("start"), not updated or
// ended. Every push carries the *entire* content-state (ActivityKit replaces it wholesale, not a
// diff), so startedAt must be the print's original start time, not "now" -- the caller is
// responsible for tracking that across calls (see ActivityTokenStore).
function buildActivityStatePayload({
  event,
  startedAt,
  progress = 0,
  stateLabel = 'Printing',
  jobName = null,
  estimatedEndAt = null,
  currentLayer = null,
  totalLayers = null,
  nozzleTempC = null,
  bedTempC = null,
  coverImage = null,
  liveSnapshot = null,
  issueSeverity = null,
  issueCount = null,
  now = new Date(),
}) {
  return {
    aps: {
      timestamp: Math.floor(now.getTime() / 1000),
      event,
      'content-state': buildContentState({
        startedAt, progress, stateLabel, jobName, estimatedEndAt, currentLayer, totalLayers, nozzleTempC, bedTempC, coverImage, liveSnapshot, issueSeverity, issueCount,
      }),
      // dismissal-date is a TOP-LEVEL aps key, interpreted directly by APNs/the system -- unlike
      // content-state's own Date fields, it is NOT Codable-decoded by the app's Swift struct, so
      // it uses plain Unix epoch seconds (same convention as aps.timestamp above), not
      // toAppleReferenceTimestamp(). Only meaningful for "end" -- an activity that isn't ending
      // has nothing to dismiss.
      ...(event === 'end' ? { 'dismissal-date': Math.floor((now.getTime() + DISMISSAL_DELAY_MS) / 1000) } : {}),
    },
  };
}

// A plain content-available push to the app's own APNs device token (not a Live Activity
// token). Wakes NozzleCast briefly in the background so its own `PrintLiveActivityManager.sync`
// runs — the only code path that ever populates `Activity<PrintActivityAttributes>.activities`
// for *any* process, including the Notification Service Extension. A push-to-start-created
// activity is otherwise invisible everywhere (app, NSE, widget) until something runs that sync,
// confirmed against a real device: the activity appeared and sat frozen until the app was
// manually foregrounded once, at which point updates started flowing.
function buildBackgroundWakePayload() {
  return {
    aps: {
      'content-available': 1,
    },
  };
}

module.exports = { buildPushToStartPayload, buildActivityStatePayload, buildBackgroundWakePayload };

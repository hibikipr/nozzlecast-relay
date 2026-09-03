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

function buildContentState({ startedAt, progress = 0, stateLabel = 'Printing', estimatedEndAt = null }) {
  return {
    progress,
    stateLabel,
    jobName: null,
    startedAt: toAppleReferenceTimestamp(startedAt),
    estimatedEndAt: estimatedEndAt ? toAppleReferenceTimestamp(estimatedEndAt) : null,
    currentLayer: null,
    totalLayers: null,
    nozzleTempC: null,
    bedTempC: null,
    coverImage: null,
    liveSnapshot: null,
  };
}

function buildPushToStartPayload({ printerID, printerName, now = new Date() }) {
  return {
    aps: {
      timestamp: Math.floor(now.getTime() / 1000),
      event: 'start',
      'content-state': buildContentState({ startedAt: now }),
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
function buildActivityStatePayload({ event, startedAt, progress = 0, stateLabel = 'Printing', estimatedEndAt = null, now = new Date() }) {
  return {
    aps: {
      timestamp: Math.floor(now.getTime() / 1000),
      event,
      'content-state': buildContentState({ startedAt, progress, stateLabel, estimatedEndAt }),
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

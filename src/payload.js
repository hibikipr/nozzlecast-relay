// Date.prototype.toISOString() includes fractional seconds ("...13:23:34.123Z"), but Swift's
// JSONDecoder .iso8601 date strategy -- which ActivityKit uses to decode a push-to-start
// payload's content-state on-device -- does NOT parse fractional seconds by default. A decode
// failure there is silent: APNs still accepts and delivers the push (the server sees a normal
// 2xx), but the Live Activity is simply never created, with no error surfaced anywhere.
// Confirmed as the real cause of exactly that symptom against a live deploy. Stripping the
// milliseconds produces the plain-seconds ISO 8601 form ISO8601DateFormatter's default options
// actually parse.
function toWholeSecondISOString(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function buildContentState(now) {
  return {
    progress: 0,
    stateLabel: 'Printing',
    jobName: null,
    startedAt: toWholeSecondISOString(now),
    estimatedEndAt: null,
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
      'content-state': buildContentState(now),
      'attributes-type': 'PrintActivityAttributes',
      attributes: { printerID, printerName },
      alert: { title: 'Print Started', body: `${printerName} is printing` },
    },
  };
}

module.exports = { buildPushToStartPayload };

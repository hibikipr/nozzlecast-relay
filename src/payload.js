function buildContentState(now) {
  return {
    progress: 0,
    stateLabel: 'Printing',
    jobName: null,
    // ActivityKit always decodes a pushed content-state with Foundation's DEFAULT JSONDecoder
    // strategy (no custom date strategy is applied, regardless of what the app's own decoders
    // elsewhere use) -- and Foundation's default Date decoding strategy is `.deferredToDate`,
    // which expects a raw Unix timestamp number (seconds since 1970), not any string form at
    // all. An ISO8601 string previously sent here (with or without fractional seconds) is a
    // type mismatch, not a format mismatch -- Apple's own guidance is explicit that this is a
    // common cause of push-to-start silently doing nothing: APNs accepts and delivers the push
    // fine, but the device can't construct ContentState from it, with zero error surfaced
    // anywhere. Confirmed as the real remaining cause against a live deploy after an earlier,
    // still-wrong ISO8601-string attempt at this same field.
    startedAt: Math.floor(now.getTime() / 1000),
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

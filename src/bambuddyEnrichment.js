// Pure mapping from a Bambuddy /status DTO onto buildContentState's optional enrichment
// parameters. Kept separate from index.js's orchestration (network calls, printer-id caching,
// fail-open error handling) so the mapping itself is unit-testable without any fetch/cache
// machinery.
//
// stateLabel and the update-vs-end choice are deliberately NOT derived from status.state here --
// those stay driven by the ntfy title in index.js/parsing.js. By the time a "Print Complete"
// ntfy event fires, Bambuddy's live status may already read "idle" or similar, which would race
// with detecting the *event* itself. Bambuddy's API is the source for telemetry; ntfy stays the
// source for event timing.
function enrichmentFromStatus(status, { now = new Date() } = {}) {
  const remainingTimeSeconds = typeof status.remainingTime === 'number' ? status.remainingTime : null;
  return {
    progress: typeof status.progress === 'number' ? status.progress / 100 : null,
    jobName: status.subtaskName ?? null,
    currentLayer: typeof status.layerNum === 'number' ? status.layerNum : null,
    totalLayers: typeof status.totalLayers === 'number' ? status.totalLayers : null,
    nozzleTempC: status.temperatures?.nozzle ?? null,
    bedTempC: status.temperatures?.bed ?? null,
    estimatedEndAt: remainingTimeSeconds !== null ? new Date(now.getTime() + remainingTimeSeconds * 1000) : null,
  };
}

module.exports = { enrichmentFromStatus };

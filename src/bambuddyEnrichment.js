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
  // Bambuddy's actual /status response uses snake_case (subtask_name, layer_num, total_layers,
  // remaining_time) -- confirmed against a real deploy, not the camelCase the original design
  // spec assumed (presumably going by how BambuddyAPIClient.swift's Decodable properties are
  // *named* on the Swift side, without accounting for its JSONDecoder's key-conversion
  // strategy). progress/temperatures.{nozzle,bed} happen to be single words either way, so
  // those were unaffected -- but subtaskName/layerNum/totalLayers/remainingTime were silently
  // always undefined against the real API, exactly as null as if Bambuddy had never returned
  // them at all.
  const remainingTimeSeconds = typeof status.remaining_time === 'number' ? status.remaining_time : null;
  // PrintActivityAttributes.ContentState declares nozzleTempC/bedTempC as Swift Int?, matching
  // the app's existing Int-everywhere convention for displayed temps -- confirmed as a real bug
  // against a live deploy: Bambuddy's raw temperatures.{nozzle,bed} are fractional Doubles (e.g.
  // 74.59375), and JSONDecoder's default Int decoding does NOT truncate a fractional JSON
  // number, it throws a type-mismatch error. Since ActivityKit decodes the entire content-state
  // as one struct, that one field failing silently failed the WHOLE push-to-start on-device --
  // APNs itself still returned a clean 200, since Apple never validates the payload against the
  // app's actual Swift types, only that it's well-formed JSON.
  const roundedOrNull = (value) => (typeof value === 'number' ? Math.round(value) : null);
  return {
    progress: typeof status.progress === 'number' ? status.progress / 100 : null,
    jobName: status.subtask_name ?? null,
    currentLayer: typeof status.layer_num === 'number' ? status.layer_num : null,
    totalLayers: typeof status.total_layers === 'number' ? status.total_layers : null,
    nozzleTempC: roundedOrNull(status.temperatures?.nozzle),
    bedTempC: roundedOrNull(status.temperatures?.bed),
    estimatedEndAt: remainingTimeSeconds !== null ? new Date(now.getTime() + remainingTimeSeconds * 1000) : null,
  };
}

module.exports = { enrichmentFromStatus };

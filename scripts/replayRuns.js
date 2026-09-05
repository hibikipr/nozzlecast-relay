// Real print-lifecycle timings/progress used by replay-run.js to send realistic APNs
// push-to-start/update/end traffic for testing the Live Activity widget without waiting for an
// actual print. `atSec`/`progress`/`stateLabel` are always real recorded values (offsets from
// each run's own push-to-start). The other content-state fields' fidelity varies per run -- see
// each run's own comment: the first two below were reconstructed from relay logs on 2026-09-03,
// which only ever recorded progress and state transitions (never the full content-state), so
// `currentLayer`/`nozzleTempC`/`bedTempC`/`remainingTimeMinutes` there are synthesized to be
// plausible, not verbatim. The third was recorded live on 2026-09-05 by polling Bambuddy's own
// status endpoint directly, so its progress/currentLayer/remainingTimeMinutes ARE the real
// values (temps are still a single representative fixed value, since the schema only carries
// one per run).

const RUNS = {
  // Reconstructed from real log timestamps 2026-09-03 14:22:21 (push-to-start) through 14:28:53
  // (Activity end sent, progress=0.96) -- a full RUNNING -> FINISH lifecycle with no pause/error,
  // the cleanest complete real run of the night. Exercises: push-to-start rendering, progress/ETA
  // updates climbing to completion, "Complete" end state + dismissal-date.
  'sam-p1s-finish': {
    printerName: 'TEST Sam P1S Replay',
    jobName: 'replay-test-finish.gcode',
    totalLayers: 220,
    nozzleTempC: 220,
    bedTempC: 60,
    steps: [
      { atSec: 0, kind: 'start' },
      { atSec: 86, kind: 'update', stateLabel: 'Printing', progress: 0.56, remainingTimeMinutes: 1 },
      { atSec: 101, kind: 'update', stateLabel: 'Printing', progress: 0.62, remainingTimeMinutes: 1 },
      { atSec: 189, kind: 'update', stateLabel: 'Printing', progress: 0.64, remainingTimeMinutes: 2 },
      { atSec: 204, kind: 'update', stateLabel: 'Printing', progress: 0.64, remainingTimeMinutes: 2 },
      { atSec: 299, kind: 'update', stateLabel: 'Printing', progress: 0.83, remainingTimeMinutes: 1 },
      { atSec: 314, kind: 'update', stateLabel: 'Printing', progress: 0.86, remainingTimeMinutes: 1 },
      { atSec: 383, kind: 'end', stateLabel: 'Complete', progress: 0.96, remainingTimeMinutes: 0 },
    ],
  },

  // Reconstructed from real log timestamps 2026-09-03 13:48:05 (push-to-start) through 13:53:19
  // (Activity end sent, progress=0.64) -- a real RUNNING -> PAUSE -> FAILED lifecycle with no HMS
  // issue confirmed active at the time. Exercises: "Paused" mid-print state, and the "Stopped"
  // (not "Failed") end label used when a FAILED transition has no qualifying HMS issue behind it
  // -- see ARCHITECTURE.md's "onFailed's stateLabel" section for why that distinction matters.
  'sam-p1s-paused-stopped': {
    printerName: 'TEST Sam P1S Replay (paused/stopped)',
    jobName: 'replay-test-paused-stopped.gcode',
    totalLayers: 220,
    nozzleTempC: 215,
    bedTempC: 55,
    steps: [
      { atSec: 0, kind: 'start' },
      { atSec: 84, kind: 'update', stateLabel: 'Printing', progress: 0, remainingTimeMinutes: 8 },
      { atSec: 99, kind: 'update', stateLabel: 'Printing', progress: 0.06, remainingTimeMinutes: 7 },
      { atSec: 194, kind: 'update', stateLabel: 'Printing', progress: 0.63, remainingTimeMinutes: 2 },
      { atSec: 209, kind: 'update', stateLabel: 'Printing', progress: 0.64, remainingTimeMinutes: 2 },
      { atSec: 249, kind: 'update', stateLabel: 'Paused', progress: 0.64, remainingTimeMinutes: 2 },
      { atSec: 284, kind: 'update', stateLabel: 'Paused', progress: 0.64, remainingTimeMinutes: 2 },
      { atSec: 315, kind: 'end', stateLabel: 'Stopped', progress: 0.64, remainingTimeMinutes: 0 },
    ],
  },

  // Reconstructed from a real Sam P1S print recorded live 2026-09-05 by polling Bambuddy's own
  // /status endpoint directly every 8s for the print's whole ~9.5min RUNNING -> FINISH lifecycle
  // (not from relay logs -- update/end pushes never fire without a registered activity token, so
  // there was nothing to reconstruct from there this time). Unlike the two runs above,
  // progress/currentLayer/remainingTimeMinutes here are the REAL recorded values, not
  // synthesized -- including the real, distinctly non-linear relationship between them: progress
  // rockets to 65% while currentLayer stays 0 (a prime/skirt phase Bambuddy counts toward
  // progress% but not layer_num), then currentLayer catches up fast once real per-layer printing
  // starts. nozzleTempC/bedTempC are still a single representative fixed value (220/45,
  // matching the mid-print steady state) since the run schema only carries one value for the
  // whole run, not per-step -- real readings swung from ~60 to ~250 during heating.
  'sam-p1s-realistic-nonlinear-layers': {
    printerName: 'TEST Sam P1S Replay (real telemetry)',
    jobName: 'No  AMS Version - 0.16mm layer, 2 walls, 15% infill',
    totalLayers: 31,
    nozzleTempC: 220,
    bedTempC: 45,
    steps: [
      { atSec: 0, kind: 'start' },
      { atSec: 82, kind: 'update', stateLabel: 'Printing', progress: 0.06, remainingTimeMinutes: 8, currentLayer: 0 },
      { atSec: 98, kind: 'update', stateLabel: 'Printing', progress: 0.56, remainingTimeMinutes: 3, currentLayer: 0 },
      { atSec: 383, kind: 'update', stateLabel: 'Printing', progress: 0.65, remainingTimeMinutes: 3, currentLayer: 0 },
      { atSec: 416, kind: 'update', stateLabel: 'Printing', progress: 0.74, remainingTimeMinutes: 2, currentLayer: 2 },
      { atSec: 481, kind: 'update', stateLabel: 'Printing', progress: 0.87, remainingTimeMinutes: 0, currentLayer: 20 },
      { atSec: 530, kind: 'update', stateLabel: 'Printing', progress: 0.96, remainingTimeMinutes: 0, currentLayer: 31 },
      { atSec: 570, kind: 'end', stateLabel: 'Complete', progress: 1, remainingTimeMinutes: 0, currentLayer: 31 },
    ],
  },
};

module.exports = { RUNS };

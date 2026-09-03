// Real print-lifecycle timings/progress reconstructed from nozzlecast-relay's own production
// logs on 2026-09-03 (journalctl -t nozzlecast-relay) -- used by replay-run.js to send realistic
// APNs push-to-start/update/end traffic for testing the Live Activity widget without waiting for
// an actual print. `atSec` and `progress`/`stateLabel` are the real recorded values (offsets from
// each run's own push-to-start). `currentLayer`/`nozzleTempC`/`bedTempC`/`remainingTimeMinutes`
// are NOT verbatim historical values -- the relay's logs only ever recorded progress and state
// transitions, never the full content-state -- they're synthesized to be plausible for the
// printer/timing/progress that WAS logged, so the widget has something realistic to render.

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
};

module.exports = { RUNS };

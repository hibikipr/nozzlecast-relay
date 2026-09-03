// Bambu Lab's raw MQTT gcode_state values, passed straight through by Bambuddy's own API.
// RUNNING/FINISH/FAILED are directly confirmed against Bambuddy's own OpenAPI docs (its
// endpoint descriptions reference "RUNNING state only", "FINISH/FAILED state" verbatim) and
// against a real live status response (state: "FINISH" observed after a completed print).
// PAUSE is the well-documented value from the wider Bambu Lab community's reverse-engineered
// MQTT protocol, but NOT yet independently confirmed against this specific Bambuddy deploy --
// the relay's API key is deliberately read-only (see bambuddyEnrichment design), so it can't
// trigger a real pause to check. Every observed raw `state` transition is logged at the call
// site specifically so a wrong guess here is a one-line, first-real-pause fix rather than a
// silent miss.
const RUNNING = 'RUNNING';
const PAUSE = 'PAUSE';
const FINISH = 'FINISH';
const FAILED = 'FAILED';

// Classifies a state transition into one of the events the relay reacts to, or null for a
// transition that isn't (or hasn't) changed / doesn't matter (e.g. PREPARE -> SLICING). Returns
// null rather than throwing for an unrecognized state string on either side -- an unexpected
// value from Bambuddy should just result in no event this tick, not a crash.
function classifyTransition(previousState, currentState) {
  if (previousState === currentState) return null;
  // PAUSE -> RUNNING must be checked before the general "anything else -> RUNNING is a start"
  // rule below, since PAUSE is also "not RUNNING" and would otherwise be misclassified as a
  // brand-new start rather than a resume of the same print.
  if (previousState === PAUSE && currentState === RUNNING) return 'resume';
  if (previousState !== RUNNING && currentState === RUNNING) return 'start';
  if (previousState === RUNNING && currentState === PAUSE) return 'pause';
  if (currentState === FINISH && previousState !== FINISH) return 'finish';
  if (currentState === FAILED && previousState !== FAILED) return 'failed';
  return null;
}

module.exports = { classifyTransition, RUNNING, PAUSE, FINISH, FAILED };

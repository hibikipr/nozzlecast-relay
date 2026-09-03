#!/usr/bin/env node
// Replays a real print lifecycle (see replayRuns.js) as live APNs push-to-start + update + end
// traffic against whatever push-to-start tokens are currently registered -- for testing the
// NozzleCast Live Activity widget's rendering (progress, ETA, temps, layers, pause/stopped/
// complete labels, dismissal) without waiting for an actual print to run.
//
// Must run with the SAME DATA_DIR/env as the live relay -- it reads tokens.json directly to know
// who to push-to-start, and polls activity-tokens.json to discover the per-activity token the app
// registers via /register-activity (the live relay's own HTTP server handles that POST for real;
// this script never touches the server, it only reads the file it writes to). Run it inside the
// relay container:
//
//   docker compose exec nozzlecast-relay node scripts/replay-run.js --run sam-p1s-finish
//
// Uses a synthetic printerID ("test-replay-<run>") that will never collide with a real Bambuddy
// printer name, so this is safe to run alongside a real print in progress on another printer.

const path = require('node:path');
const { loadConfig } = require('../src/config');
const { TokenStore } = require('../src/tokenStore');
const { ActivityTokenStore } = require('../src/activityTokenStore');
const { ApnsAuthProvider } = require('../src/apnsAuth');
const { ApnsClient } = require('../src/apnsClient');
const { normalizedID } = require('../src/parsing');
const { buildPushToStartPayload, buildActivityStatePayload } = require('../src/payload');
const { RUNS } = require('./replayRuns');

function parseArgs(argv) {
  const args = { speed: 15, timeoutMs: 60000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--run') args.run = argv[++i];
    else if (arg === '--speed') args.speed = Number(argv[++i]);
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++i]);
    else if (arg === '--printer-id') args.printerID = argv[++i];
    else if (arg === '--list') args.list = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

function printUsage() {
  console.log(`Usage: node scripts/replay-run.js --run <name> [options]

Options:
  --run <name>          Which run to replay (see list below). Required.
  --speed <n>            Compress real-world timing by this factor (default 15 -- a ~6.4 min real
                          run finishes in well under a minute). Use 1 for real-time playback.
  --timeout-ms <n>        How long to wait after push-to-start for the app's /register-activity
                          call before giving up on update/end pushes (default 60000).
  --printer-id <id>      Override the synthetic printerID (default: "test-replay-<run>").
  --list                 List available runs and exit.

Run this INSIDE the relay container (shares its DATA_DIR/env), e.g.:
  docker compose exec nozzlecast-relay node scripts/replay-run.js --run sam-p1s-finish

Available runs:
${Object.keys(RUNS).map((name) => `  - ${name}`).join('\n')}
`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForActivityToken(activityTokenStore, printerID, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await activityTokenStore.load();
    const entry = activityTokenStore.get(printerID);
    if (entry && entry.token) return entry;
    process.stdout.write('.');
    await sleep(2000);
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    printUsage();
    return;
  }
  if (args.help || !args.run) {
    printUsage();
    process.exit(args.help ? 0 : 1);
  }

  const run = RUNS[args.run];
  if (!run) {
    console.error(`Unknown run "${args.run}". Available: ${Object.keys(RUNS).join(', ')}`);
    process.exit(1);
  }

  const config = loadConfig();
  const printerID = args.printerID || normalizedID(`test-replay-${args.run}`);

  const tokenStore = new TokenStore(path.join(config.dataDir, 'tokens.json'));
  await tokenStore.load();
  const activityTokenStore = new ActivityTokenStore(path.join(config.dataDir, 'activity-tokens.json'));
  await activityTokenStore.load();

  if (tokenStore.list().length === 0) {
    console.error('No push-to-start tokens registered in tokens.json -- open NozzleCast at least once so it registers one, then retry.');
    process.exit(1);
  }

  const apnsClients = {
    sandbox: new ApnsClient({
      authProvider: new ApnsAuthProvider({ keyPath: config.apnsSandboxKeyPath, keyId: config.apnsSandboxKeyId, teamId: config.apnsTeamId }),
      topic: config.apnsTopic,
    }),
    production: new ApnsClient({
      authProvider: new ApnsAuthProvider({ keyPath: config.apnsKeyPath, keyId: config.apnsKeyId, teamId: config.apnsTeamId }),
      topic: config.apnsTopic,
    }),
  };

  console.log(`Replaying "${args.run}" as printerID "${printerID}" (${run.steps.length} steps, speed=${args.speed}x)\n`);

  // Fixed for the whole replay, NOT re-read from activity-tokens.json's startedAt: that field
  // would be null here (startPrint() is only ever called by the real relay's own onNtfyMessage/
  // onStart handlers, which this script deliberately never invokes -- it only sends APNs directly
  // and reads the file the app's /register-activity call writes to). Every content-state push
  // must carry the SAME startedAt or the widget's elapsed-time math would be inconsistent across
  // updates.
  const replayStartedAt = new Date();
  let previousAtSec = 0;

  for (const step of run.steps) {
    const waitMs = ((step.atSec - previousAtSec) * 1000) / args.speed;
    if (waitMs > 0) await sleep(waitMs);
    previousAtSec = step.atSec;

    if (step.kind === 'start') {
      console.log(`[t=${step.atSec}s] push-to-start`);
      const payload = buildPushToStartPayload({
        printerID,
        printerName: run.printerName,
        now: replayStartedAt,
        jobName: run.jobName,
        currentLayer: 0,
        totalLayers: run.totalLayers,
        nozzleTempC: run.nozzleTempC,
        bedTempC: run.bedTempC,
      });
      for (const entry of tokenStore.list()) {
        const client = apnsClients[entry.environment] || apnsClients.production;
        const result = await client.send({ token: entry.token, environment: entry.environment, payload });
        console.log(`  -> ${entry.environment} token ...${entry.token.slice(-8)}: ${result.ok ? 'OK' : `FAILED (${result.status}) ${result.body}`}`);
      }
      process.stdout.write('Waiting for the app to register this activity\'s push token via /register-activity ');
      const activity = await waitForActivityToken(activityTokenStore, printerID, args.timeoutMs);
      console.log('');
      if (!activity) {
        console.error(`Timed out after ${args.timeoutMs}ms -- open NozzleCast now if it isn't foregrounded, or rerun with a longer --timeout-ms. Continuing: update/end pushes below will just be skipped, same as a real print whose registration never lands in time.`);
      } else {
        console.log(`Registered: token ...${activity.token.slice(-8)} (${activity.environment})\n`);
      }
      continue;
    }

    await activityTokenStore.load();
    const activity = activityTokenStore.get(printerID);
    if (!activity || !activity.token) {
      console.log(`[t=${step.atSec}s] ${step.kind} stateLabel=${step.stateLabel} progress=${step.progress} -- SKIPPED, no activity token registered`);
      continue;
    }

    const now = new Date();
    const estimatedEndAt = step.remainingTimeMinutes > 0
      ? new Date(now.getTime() + step.remainingTimeMinutes * 60 * 1000)
      : null;
    const payload = buildActivityStatePayload({
      event: step.kind,
      startedAt: replayStartedAt,
      progress: step.progress,
      stateLabel: step.stateLabel,
      jobName: run.jobName,
      estimatedEndAt,
      currentLayer: Math.round(step.progress * run.totalLayers),
      totalLayers: run.totalLayers,
      nozzleTempC: run.nozzleTempC,
      bedTempC: run.bedTempC,
      now,
    });
    const client = apnsClients[activity.environment] || apnsClients.production;
    const result = await client.send({ token: activity.token, environment: activity.environment, payload });
    console.log(`[t=${step.atSec}s] ${step.kind} stateLabel=${step.stateLabel} progress=${step.progress}: ${result.ok ? 'OK' : `FAILED (${result.status}) ${result.body}`}`);
  }

  console.log('\nReplay complete.');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

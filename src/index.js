const http = require('node:http');
const path = require('node:path');
const { loadConfig } = require('./config');
const {
  isStartEvent,
  isProgressEvent,
  isEndEvent,
  progressFraction,
  endStateLabel,
  printerName,
  normalizedID,
} = require('./parsing');
const { StartEventDedupe } = require('./dedupe');
const { buildPushToStartPayload, buildActivityStatePayload, buildBackgroundWakePayload } = require('./payload');
const { TokenStore } = require('./tokenStore');
const { ActivityTokenStore } = require('./activityTokenStore');
const { ApnsAuthProvider } = require('./apnsAuth');
const { ApnsClient } = require('./apnsClient');
const { createServer } = require('./server');
const { NtfyWatcher } = require('./ntfyWatcher');

async function main() {
  const config = loadConfig();

  const tokenStore = new TokenStore(path.join(config.dataDir, 'tokens.json'));
  await tokenStore.load();

  const deviceTokenStore = new TokenStore(path.join(config.dataDir, 'device-tokens.json'));
  await deviceTokenStore.load();

  const activityTokenStore = new ActivityTokenStore(path.join(config.dataDir, 'activity-tokens.json'));
  await activityTokenStore.load();

  // Apple APNs auth keys are ordinarily environment-agnostic, but confirmed empirically against
  // a real deploy that this key pair isn't: a production-scoped key's JWT got a 403
  // BadEnvironmentKeyInToken (auth-tier rejection) from api.sandbox.push.apple.com, while the
  // exact same JWT sent to api.push.apple.com got the normal token-tier 400 BadDeviceToken. So
  // each environment gets its own auth provider and client, selected per-token at send time
  // rather than assuming one key covers both.
  const apnsClients = {
    sandbox: new ApnsClient({
      authProvider: new ApnsAuthProvider({
        keyPath: config.apnsSandboxKeyPath,
        keyId: config.apnsSandboxKeyId,
        teamId: config.apnsTeamId,
      }),
      topic: config.apnsTopic,
    }),
    production: new ApnsClient({
      authProvider: new ApnsAuthProvider({
        keyPath: config.apnsKeyPath,
        keyId: config.apnsKeyId,
        teamId: config.apnsTeamId,
      }),
      topic: config.apnsTopic,
    }),
  };
  const dedupe = new StartEventDedupe();

  // Startup auth check, once per environment/key pair: send to a syntactically-valid-but-
  // nonexistent device token. A working key/kid/team-id combination gets a 400 BadDeviceToken
  // (auth succeeded, token just isn't real); a misconfigured one gets 403. Fail loudly now
  // rather than silently dropping every future push-to-start request.
  //
  // This check is best-effort: it must never block startup. A hung TCP/TLS connection to Apple
  // (ApnsClient has no per-request timeout) would otherwise stall server.listen() forever, and a
  // thrown error (e.g. DNS not yet resolvable in a fresh container) would otherwise propagate to
  // main().catch() and exit(1), turning a transient network hiccup into a crash-loop. We only
  // exit on a definitive, successfully-received 403 — an unambiguous "your credentials are
  // wrong" answer from Apple.
  const AUTH_CHECK_TIMEOUT_MS = 10000;
  for (const environment of ['sandbox', 'production']) {
    try {
      const authCheckResult = await Promise.race([
        apnsClients[environment].send({
          token: '0'.repeat(64),
          environment,
          payload: buildPushToStartPayload({ printerID: 'startup-check', printerName: 'startup-check' }),
        }).then((result) => ({ timedOut: false, result })),
        new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), AUTH_CHECK_TIMEOUT_MS)),
      ]);

      if (authCheckResult.timedOut) {
        console.error(`APNs ${environment} auth check timed out after ${AUTH_CHECK_TIMEOUT_MS}ms — continuing startup anyway`);
      } else if (authCheckResult.result.status === 403) {
        console.error(`APNs ${environment} auth check failed (403 ${authCheckResult.result.body}) — check the ${environment} APNS_KEY_ID/APNS_KEY_PATH pair`);
        process.exit(1);
      } else {
        console.log(`APNs ${environment} auth check passed (status ${authCheckResult.result.status}, as expected for a fake device token)`);
      }
    } catch (error) {
      console.error(`APNs ${environment} auth check threw (network/DNS issue?) — continuing startup anyway:`, error);
    }
  }

  const onNtfyMessage = async (message) => {
    const title = message.title || '';
    const name = printerName(message.message || '');
    if (!name) return;
    const printerID = normalizedID(name);

    if (isStartEvent(title)) {
      if (!dedupe.shouldTrigger(printerID)) return;
      await activityTokenStore.startPrint({ printerID, printerName: name, startedAt: new Date().toISOString() });
      await sendPushToStart({ printerID, name });
      return;
    }

    if (isProgressEvent(title) || isEndEvent(title)) {
      await sendActivityUpdate({ title, printerID, name });
    }
  };

  const sendPushToStart = async ({ printerID, name }) => {
    const payload = buildPushToStartPayload({ printerID, printerName: name });
    for (const entry of tokenStore.list()) {
      try {
        const client = apnsClients[entry.environment] || apnsClients.production;
        const result = await client.send({ token: entry.token, environment: entry.environment, payload });
        if (result.shouldRemoveToken) {
          await tokenStore.remove(entry.token);
          console.log(`Removed dead token (status ${result.status}): ${entry.token}`);
        } else if (!result.ok) {
          console.error(`Push-to-start send failed (status ${result.status}) for token ${entry.token}: ${result.body}`);
        } else {
          console.log(`Push-to-start sent for printer "${name}" to token ${entry.token}`);
        }
      } catch (error) {
        console.error(`Push-to-start send threw for token ${entry.token}:`, error);
      }
    }

    // Also wake the app itself in the background: a push-to-start-created activity is invisible
    // to `Activity<PrintActivityAttributes>.activities` everywhere (app, NSE, widget) until the
    // app runs its own `PrintLiveActivityManager.sync` at least once — see buildBackgroundWakePayload.
    const wakePayload = buildBackgroundWakePayload();
    for (const entry of deviceTokenStore.list()) {
      try {
        const client = apnsClients[entry.environment] || apnsClients.production;
        const result = await client.send({
          token: entry.token,
          environment: entry.environment,
          payload: wakePayload,
          pushType: 'background',
          topic: config.apnsBundleId,
        });
        if (result.shouldRemoveToken) {
          await deviceTokenStore.remove(entry.token);
          console.log(`Removed dead device token (status ${result.status}): ${entry.token}`);
        } else if (!result.ok) {
          console.error(`Background wake send failed (status ${result.status}) for device token ${entry.token}: ${result.body}`);
        } else {
          console.log(`Background wake sent for printer "${name}" to device token ${entry.token}`);
        }
      } catch (error) {
        console.error(`Background wake send threw for device token ${entry.token}:`, error);
      }
    }
  };

  // Updates or ends an existing Live Activity directly via its own per-activity push token,
  // looked up by printerID -- no dependency on the app, NSE, or widget ever running again after
  // the initial push-to-start (see the relay design doc for why that path can't be relied on).
  // Every push must carry the activity's *entire* content-state, so this reuses the startedAt
  // tracked by activityTokenStore.startPrint() rather than "now" -- the print's real start time
  // doesn't change just because it's mid-print.
  const sendActivityUpdate = async ({ title, printerID, name }) => {
    const activity = activityTokenStore.get(printerID);
    if (!activity || !activity.token) {
      console.log(`No activity token registered for printer "${name}", skipping ${isEndEvent(title) ? 'end' : 'update'} push`);
      return;
    }

    const event = isEndEvent(title) ? 'end' : 'update';
    const progress = event === 'end' ? 1 : progressFraction(title);
    const stateLabel = event === 'end' ? endStateLabel(title) : 'Printing';
    const startedAt = activity.startedAt ? new Date(activity.startedAt) : new Date();

    const payload = buildActivityStatePayload({ event, startedAt, progress, stateLabel });
    try {
      const client = apnsClients[activity.environment] || apnsClients.production;
      const result = await client.send({ token: activity.token, environment: activity.environment, payload });
      if (result.shouldRemoveToken) {
        await activityTokenStore.clearToken(printerID);
        console.log(`Removed dead activity token (status ${result.status}) for printer "${name}"`);
      } else if (!result.ok) {
        console.error(`Activity ${event} send failed (status ${result.status}) for printer "${name}": ${result.body}`);
      } else {
        console.log(`Activity ${event} sent for printer "${name}" (progress=${progress ?? 'n/a'})`);
      }
    } catch (error) {
      console.error(`Activity ${event} send threw for printer "${name}":`, error);
    }
  };

  const watcher = new NtfyWatcher({
    server: config.ntfyServer,
    topic: config.ntfyTopic,
    authToken: config.ntfyAuthToken,
    onMessage: onNtfyMessage,
  });
  watcher.start();

  const app = createServer({ tokenStore, deviceTokenStore, activityTokenStore, authSecret: config.relayAuthSecret });
  const port = process.env.PORT || 3000;
  const server = http.createServer(app);
  server.listen(port, () => {
    console.log(`nozzlecast-relay listening on :${port}, watching ${config.ntfyServer}/${config.ntfyTopic}`);
  });

  const shutdown = () => {
    console.log('Shutting down...');
    watcher.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal startup error:', error);
    process.exit(1);
  });
}

module.exports = { main };

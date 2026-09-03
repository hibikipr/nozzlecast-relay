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
const { BambuddyClient } = require('./bambuddyClient');
const { PrinterIdCache } = require('./printerIdCache');
const { enrichmentFromStatus } = require('./bambuddyEnrichment');
const { downscaleImage } = require('./imageDownscale');
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

  const bambuddyClient = new BambuddyClient({ baseUrl: config.bambuddyUrl, apiKey: config.bambuddyApiKey });
  const printerIdCache = new PrinterIdCache({ bambuddyClient });

  // Exact caps from PrintLiveActivityManager.downscaledCoverImage / NotificationService.
  // downscaledThumbnail -- see imageDownscale.js for why matching these precisely (not
  // approximating) matters: ActivityKit ends the whole Live Activity outright if the serialized
  // content-state goes over budget, it doesn't just drop the offending field.
  const COVER_IMAGE_MAX_DIMENSION = 36;
  const COVER_IMAGE_MAX_BYTES = 1000;
  const LIVE_SNAPSHOT_MAX_DIMENSION = 40;
  const LIVE_SNAPSHOT_MAX_BYTES = 1300;

  // Mints a fresh (short-lived, not cacheable) camera stream token and fetches+downscales one of
  // Bambuddy's two camera-backed images. Lets a downscale-to-null (still over budget at the
  // quality floor) come back as null same as any other failure -- both mean "no image field this
  // update," never a thrown error that would abort the whole enrichment attempt.
  const fetchDownscaledCameraImage = async (bambuddyPrinterId, fetchRaw, { maxDimension, maxBytes }) => {
    const streamToken = await bambuddyClient.mintCameraStreamToken();
    const raw = await fetchRaw(bambuddyPrinterId, streamToken);
    const downscaled = await downscaleImage(raw, { maxDimension, maxBytes });
    return downscaled ? downscaled.toString('base64') : null;
  };

  // Best-effort enrichment of a content-state beyond what ntfy's alert text carries (progress,
  // job name, layer/temperature telemetry, estimated end time, and now the cover/live-camera
  // images) -- fails open on any error (printer not found, Bambuddy unreachable/slow, malformed
  // response), same philosophy as the startup APNs auth check's timeout race: a slow/unreachable
  // Bambuddy must never stall or crash a push, it should just fall back to the old text-only
  // fields (progress from the ntfy title, everything else null).
  //
  // coverImage is static for the whole job, so it's fetched+downscaled at most once per print and
  // cached on activityTokenStore's per-printer record from then on (checked here before ever
  // re-fetching); liveSnapshot is meant to look "live," so includeLiveSnapshot callers (progress/
  // end events) get a fresh fetch+mint every time rather than a cached one -- push-to-start omits
  // it entirely rather than spending a stream-token mint on an image that's discarded unused.
  const fetchEnrichment = async (printerID, name, { includeLiveSnapshot = false } = {}) => {
    try {
      const bambuddyPrinterId = await printerIdCache.resolve(printerID);
      if (bambuddyPrinterId === null) return null;

      const status = await bambuddyClient.status(bambuddyPrinterId);
      const enrichment = enrichmentFromStatus(status);

      const cachedCoverImage = activityTokenStore.get(printerID)?.coverImage;
      if (cachedCoverImage) {
        enrichment.coverImage = cachedCoverImage;
      } else {
        enrichment.coverImage = await fetchDownscaledCameraImage(
          bambuddyPrinterId,
          (id, token) => bambuddyClient.cover(id, token),
          { maxDimension: COVER_IMAGE_MAX_DIMENSION, maxBytes: COVER_IMAGE_MAX_BYTES },
        );
        if (enrichment.coverImage) await activityTokenStore.setCoverImage(printerID, enrichment.coverImage);
      }

      enrichment.liveSnapshot = includeLiveSnapshot
        ? await fetchDownscaledCameraImage(
            bambuddyPrinterId,
            (id, token) => bambuddyClient.cameraSnapshot(id, token),
            { maxDimension: LIVE_SNAPSHOT_MAX_DIMENSION, maxBytes: LIVE_SNAPSHOT_MAX_BYTES },
          )
        : null;

      return enrichment;
    } catch (error) {
      console.error(`Bambuddy enrichment failed for printer "${name}", falling back to text-only content-state:`, error);
      return null;
    }
  };

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
    const enrichment = await fetchEnrichment(printerID, name);
    const payload = buildPushToStartPayload({
      printerID,
      printerName: name,
      jobName: enrichment?.jobName ?? null,
      estimatedEndAt: enrichment?.estimatedEndAt ?? null,
      currentLayer: enrichment?.currentLayer ?? null,
      totalLayers: enrichment?.totalLayers ?? null,
      nozzleTempC: enrichment?.nozzleTempC ?? null,
      bedTempC: enrichment?.bedTempC ?? null,
      coverImage: enrichment?.coverImage ?? null,
    });
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
    const stateLabel = event === 'end' ? endStateLabel(title) : 'Printing';
    const startedAt = activity.startedAt ? new Date(activity.startedAt) : new Date();

    // Prefer Bambuddy's own progress (exact) over the ntfy title's regex-parsed percentage,
    // falling back to the latter only if enrichment failed entirely -- see fetchEnrichment.
    // includeLiveSnapshot: true because this IS an update/end event -- liveSnapshot is meant to
    // look "live," so it's fetched fresh here every time rather than reused from a cache.
    const enrichment = await fetchEnrichment(printerID, name, { includeLiveSnapshot: true });
    const progress = event === 'end' ? 1 : (enrichment?.progress ?? progressFraction(title));

    const payload = buildActivityStatePayload({
      event,
      startedAt,
      progress,
      stateLabel,
      jobName: enrichment?.jobName ?? null,
      estimatedEndAt: enrichment?.estimatedEndAt ?? null,
      currentLayer: enrichment?.currentLayer ?? null,
      totalLayers: enrichment?.totalLayers ?? null,
      nozzleTempC: enrichment?.nozzleTempC ?? null,
      bedTempC: enrichment?.bedTempC ?? null,
      coverImage: enrichment?.coverImage ?? null,
      liveSnapshot: enrichment?.liveSnapshot ?? null,
    });
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

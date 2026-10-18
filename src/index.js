const http = require('node:http');
const path = require('node:path');
const { loadConfig } = require('./config');
const { buildPushToStartPayload, buildActivityStatePayload, buildBackgroundWakePayload } = require('./payload');
const { TokenStore } = require('./tokenStore');
const { ActivityTokenStore } = require('./activityTokenStore');
const { ApnsAuthProvider } = require('./apnsAuth');
const { ApnsClient } = require('./apnsClient');
const { BambuddyClient } = require('./bambuddyClient');
const { PrinterIdCache } = require('./printerIdCache');
const { enrichmentFromStatus, isRemainingTimeTrustworthy, filterStageDetail } = require('./bambuddyEnrichment');
const { downscaleImage } = require('./imageDownscale');
const { resolveCoverImage } = require('./coverImageCache');
const { createServer } = require('./server');
const { BambuddyPoller } = require('./bambuddyPoller');
const { PAUSE } = require('./printerStateClassifier');
const { WakeRetryPolicy } = require('./wakeRetryPolicy');

// Full push payloads are logged verbatim for debugging (e.g. checking attributes-type against
// the app's actual Swift struct byte-for-byte -- APNs doesn't validate that field, so a mismatch
// is otherwise invisible from the relay side). coverImage/liveSnapshot are base64 and can be tens
// of KB; replace them with a length marker so logs stay readable without losing anything that
// actually needs checking.
function redactImagesForLogging(payload) {
  const clone = JSON.parse(JSON.stringify(payload));
  const contentState = clone.aps?.['content-state'];
  if (contentState) {
    for (const field of ['coverImage', 'liveSnapshot']) {
      if (typeof contentState[field] === 'string') {
        contentState[field] = `<base64, ${contentState[field].length} chars>`;
      }
    }
  }
  return clone;
}

// Which device tokens get a background wake: only those in an environment some push-to-start
// token is also registered in. Old development builds leave sandbox device tokens behind that APNs
// keeps accepting, so they're never pruned as dead -- but a sandbox device with no sandbox
// push-to-start token can't be running a Live Activity for this print, and each wake to it still
// spends background-push budget. With no push-to-start token at all there's nothing to filter by,
// so every device gets the wake as before.
function wakeTargets(pushToStartTokens, deviceTokens) {
  const environments = new Set(pushToStartTokens.map((entry) => entry.environment));
  return environments.size === 0 ? deviceTokens : deviceTokens.filter((entry) => environments.has(entry.environment));
}

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

  // Fetches+downscales one of Bambuddy's two camera-backed images. `fetchRaw` owns whatever
  // credential its endpoint actually needs -- cover() is Bearer-authenticated like the rest of
  // the client, cameraSnapshot() needs its own fresh stream token, minted by the caller (see
  // bambuddyClient.js for why these two differ). Lets a downscale-to-null (still over budget at
  // the quality floor) come back as null same as any other failure -- both mean "no image field
  // this update," never a thrown error that would abort the whole enrichment attempt.
  const fetchDownscaledCameraImage = async (bambuddyPrinterId, fetchRaw, { maxDimension, maxBytes }) => {
    const raw = await fetchRaw(bambuddyPrinterId);
    const downscaled = await downscaleImage(raw, { maxDimension, maxBytes });
    return downscaled ? downscaled.toString('base64') : null;
  };

  // Best-effort enrichment of a content-state (progress, job name, layer/temperature telemetry,
  // estimated end time, and the cover/live-camera images) -- fails open on any error (printer not
  // found, Bambuddy unreachable/slow, malformed response), same philosophy as the startup APNs
  // auth check's timeout race: a slow/unreachable Bambuddy must never stall or crash a push, it
  // should just fall back to a content-state with those fields null.
  //
  // The numeric telemetry fetch (status + enrichmentFromStatus) and the two image fetches are
  // DELIBERATELY separate fail-open boundaries, not one big try/catch around everything --
  // confirmed live that a single camera/snapshot 503 (Bambuddy's camera endpoint is far less
  // reliable than its status endpoint) discarded an otherwise-fully-successful enrichment
  // entirely, sending progress=0/estimatedEndAt=null for a print that was actually well
  // underway with a perfectly good status response -- froze the Live Activity's display for
  // however long until the next event. An image fetch failing should only cost that one image
  // field, never the numeric fields a live-snapshot/coverImage failure has nothing to do with.
  //
  // coverImage is static for the whole job, so it's fetched+downscaled at most once per print and
  // cached on activityTokenStore's per-printer record from then on (checked here before ever
  // re-fetching); liveSnapshot is meant to look "live," so includeLiveSnapshot callers (progress/
  // end events) get a fresh fetch+mint every time rather than a cached one -- push-to-start omits
  // it entirely rather than spending a stream-token mint on an image that's discarded unused.
  //
  // The poller already knows Bambuddy's numeric id for the printer it's reporting on (it just
  // listed printers this tick), so it passes it through and the name->id cache is only the
  // fallback. The cache alone only refreshed on a miss, so a printer re-added in Bambuddy under
  // the same name got a new id the cache never learned, and every enrichment kept hitting the old
  // one until the relay restarted.
  const fetchEnrichment = async (printerID, name, { includeLiveSnapshot = false, prefetchedStatus = null, bambuddyPrinterId: knownPrinterId = null } = {}) => {
    let bambuddyPrinterId;
    let enrichment;
    try {
      bambuddyPrinterId = knownPrinterId ?? await printerIdCache.resolve(printerID);
      if (bambuddyPrinterId === null) return null;

      // BambuddyPoller already fetches a fresh status every tick to detect transitions -- reuse
      // that instead of a redundant second call when it's the one driving this enrichment.
      const status = prefetchedStatus || await bambuddyClient.status(bambuddyPrinterId);
      enrichment = enrichmentFromStatus(status);

      // Diagnostic only -- re-derives (doesn't change) whether estimatedEndAt came back null
      // specifically because the sanity check rejected an implausible remaining_time, versus
      // remaining_time simply being absent. Bambuddy's remaining_time has already been confirmed
      // flaky (a bogus near-zero value at real, non-near-complete progress); this makes it
      // possible to confirm from logs alone when that's the reason a countdown briefly
      // disappears from a Live Activity, rather than reasoning about it after the fact with no
      // record of what the raw value actually was.
      if (
        enrichment.estimatedEndAt === null
        && typeof status.remaining_time === 'number'
        && !isRemainingTimeTrustworthy(status.remaining_time, enrichment.progress)
      ) {
        console.log(
          `Bambuddy enrichment: rejected implausible remaining_time=${status.remaining_time}min at progress=${enrichment.progress} for printer "${name}" -- omitting estimatedEndAt this update`,
        );
      }
    } catch (error) {
      console.error(`Bambuddy enrichment failed for printer "${name}", falling back to text-only content-state:`, error);
      return null;
    }

    enrichment.coverImage = await resolveCoverImage({
      activityTokenStore,
      printerID,
      name,
      fetchCover: () => fetchDownscaledCameraImage(
        bambuddyPrinterId,
        (id) => bambuddyClient.cover(id),
        { maxDimension: COVER_IMAGE_MAX_DIMENSION, maxBytes: COVER_IMAGE_MAX_BYTES },
      ),
    });

    if (includeLiveSnapshot) {
      try {
        enrichment.liveSnapshot = await fetchDownscaledCameraImage(
          bambuddyPrinterId,
          async (id) => bambuddyClient.cameraSnapshot(id, await bambuddyClient.mintCameraStreamToken()),
          { maxDimension: LIVE_SNAPSHOT_MAX_DIMENSION, maxBytes: LIVE_SNAPSHOT_MAX_BYTES },
        );
      } catch (error) {
        console.error(`liveSnapshot fetch failed for printer "${name}", sending this update without it:`, error);
        enrichment.liveSnapshot = null;
      }
    } else {
      enrichment.liveSnapshot = null;
    }

    return enrichment;
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

  // Sends the background content-available wake push to every registered device token -- see
  // buildBackgroundWakePayload. Called once at push-to-start, and then retried from
  // sendActivityUpdate for as long as fewer devices have registered an activity token than
  // accepted the push-to-start. iOS's delivery of a "background" push is discretionary and can be
  // delayed with no relay-visible signal -- confirmed live: an H2C print's token didn't land for
  // ~37.5 minutes because the one-shot wake at print-start was evidently delayed by iOS, leaving
  // the activity stale with no way to retry until something unrelated (e.g. foregrounding the app)
  // happened to trigger PrintLiveActivityManager.sync on its own. Self-limiting: it stops the
  // moment every expected device's /register-activity lands.
  //
  // When to retry (partial registrations, backoff spacing, the per-print cap) is decided by
  // WakeRetryPolicy -- see wakeRetryPolicy.js for why each of those is needed. The cap matters
  // because a device whose token never arrives (Live Activities turned off, or a print that was
  // already running when the relay started, so no push-to-start ever went out) would otherwise
  // get a background push all print long, and iOS rations background pushes per app.
  const wakeRetries = new WakeRetryPolicy();

  const sendBackgroundWake = async (name) => {
    const wakePayload = buildBackgroundWakePayload();
    for (const entry of wakeTargets(tokenStore.list(), deviceTokenStore.list())) {
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
          console.log(`Background wake accepted by APNs for printer "${name}" (device token ${entry.token}, apns-id ${result.apnsId ?? 'n/a'})`);
        }
      } catch (error) {
        console.error(`Background wake send threw for device token ${entry.token}:`, error);
      }
    }
  };

  const sendPushToStart = async ({ printerID, name, prefetchedStatus = null, issueSeverity = null, issueCount = null, bambuddyPrinterId = null }) => {
    const enrichment = await fetchEnrichment(printerID, name, { prefetchedStatus, bambuddyPrinterId });
    const payload = buildPushToStartPayload({
      printerID,
      printerName: name,
      jobName: enrichment?.jobName ?? null,
      estimatedEndAt: enrichment?.estimatedEndAt ?? null,
      currentLayer: enrichment?.currentLayer ?? null,
      totalLayers: enrichment?.totalLayers ?? null,
      nozzleTempC: enrichment?.nozzleTempC ?? null,
      rightNozzleTempC: enrichment?.rightNozzleTempC ?? null,
      bedTempC: enrichment?.bedTempC ?? null,
      coverImage: enrichment?.coverImage ?? null,
      issueSeverity,
      issueCount,
      // 'Printing' is push-to-start's implicit stateLabel (buildContentState's own default,
      // not passed explicitly here) -- filtered against that literal so a print starting
      // already mid-stage-0 doesn't show a redundant "Printing" caption under "Printing".
      stageDetail: filterStageDetail(enrichment?.stageDetail, 'Printing'),
    });
    console.log(`Push-to-start payload for printer "${name}": ${Buffer.byteLength(JSON.stringify(payload))} bytes ${JSON.stringify(redactImagesForLogging(payload))}`);
    // How many devices APNs accepted the push-to-start for -- the number of activity tokens the
    // wake retry waits for (see WakeRetryPolicy).
    let acceptedDevices = 0;
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
          acceptedDevices += 1;
          console.log(`Push-to-start accepted by APNs for printer "${name}" (token ${entry.token}, apns-id ${result.apnsId ?? 'n/a'})`);
        }
      } catch (error) {
        console.error(`Push-to-start send threw for token ${entry.token}:`, error);
      }
    }

    // Also wake the app itself in the background so it refreshes its own printer state without
    // needing a foreground launch — see buildBackgroundWakePayload for why this is no longer
    // believed to be load-bearing for activity visibility.
    await sendBackgroundWake(name);
    return acceptedDevices;
  };

  // Updates or ends an existing Live Activity directly via its own per-activity push token,
  // looked up by printerID -- no dependency on the app, NSE, or widget ever running again after
  // the initial push-to-start (see the relay design doc for why that path can't be relied on).
  // Every push must carry the activity's *entire* content-state, so this reuses the startedAt
  // tracked by activityTokenStore.startPrint() rather than "now" -- the print's real start time
  // doesn't change just because it's mid-print.
  //
  // event/stateLabel are passed in already decided by BambuddyPoller's state-transition
  // classifier, not derived here.
  const sendActivityUpdate = async ({
    event, stateLabel, printerID, name, prefetchedStatus = null, priorProgress = null,
    issueSeverity = null, issueCount = null, bambuddyPrinterId = null, priority = null,
  }) => {
    const activity = activityTokenStore.get(printerID);
    const deviceTokens = activityTokenStore.tokensFor(printerID);
    if (!activity || deviceTokens.length === 0) {
      // Nothing to end: waking the app for a print that is already over can't produce a token
      // anyone will ever push to.
      if (event === 'end') {
        console.log(`No activity token registered for printer "${name}", skipping end push`);
        return;
      }
      const retry = wakeRetries.check(printerID, 0);
      if (!retry) {
        const why = wakeRetries.capReached(printerID)
          ? `background wake retry limit (${wakeRetries.maxRetries}) reached for this print`
          : 'next background wake retry not due yet';
        console.log(`No activity token registered for printer "${name}", skipping ${event} push -- ${why}`);
        return;
      }
      wakeRetries.recordWake(printerID);
      console.log(`No activity token registered for printer "${name}", skipping ${event} push -- retrying background wake (${retry.attempt}/${retry.maxRetries})`);
      await sendBackgroundWake(name);
      return;
    }

    const startedAt = activity.startedAt ? new Date(activity.startedAt) : new Date();

    // includeLiveSnapshot: true because this IS an update/end event -- liveSnapshot is meant to
    // look "live," so it's fetched fresh here every time rather than reused from a cache.
    const enrichment = await fetchEnrichment(printerID, name, { includeLiveSnapshot: true, prefetchedStatus, bambuddyPrinterId });
    // No longer hardcoded to 1 for "end" -- a genuine finish naturally reads ~100% from real
    // data anyway, but a stopped/cancelled print did NOT necessarily reach 100%, and claiming it
    // did is just factually wrong (a print stopped at 60% showing "100%" on its way out).
    //
    // priorProgress (the poller's own last-observed value, from the tick BEFORE this transition)
    // takes priority over a fresh enrichment fetch for "end" specifically: confirmed live that
    // Bambuddy resets progress to 0 the instant state becomes FAILED, so re-querying at the
    // moment of the end event itself would silently reintroduce a different wrong number (0%
    // instead of the old hardcoded 100%) for the exact same reason the hardcode was wrong.
    const progress = event === 'end'
      ? (priorProgress ?? enrichment?.progress ?? 0)
      : (enrichment?.progress ?? 0);

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
      rightNozzleTempC: enrichment?.rightNozzleTempC ?? null,
      bedTempC: enrichment?.bedTempC ?? null,
      coverImage: enrichment?.coverImage ?? null,
      liveSnapshot: enrichment?.liveSnapshot ?? null,
      issueSeverity,
      issueCount,
      stageDetail: filterStageDetail(enrichment?.stageDetail, stateLabel),
    });
    // ActivityKit's content-state has a real, silently-enforced byte budget (~4KB) -- a push
    // over it isn't rejected by APNs (which never inspects content-state) and isn't reported
    // back to us at all, it's just dropped on-device with no visible signal here. Logging the
    // actual size on every send, rather than only when something looks wrong, is what makes it
    // possible to correlate an on-device "activity didn't update" report against a specific
    // push after the fact, instead of guessing from a synthetic worst case.
    //
    // "accepted by APNs" below is deliberate wording, not a stylistic choice. A 2xx here means
    // Apple took the push, NOT that the device applied it. Two confirmed ways to get a genuine
    // 200 for a push that changes nothing on screen: liveactivitiesd declining it on its private
    // on-device budget (see ARCHITECTURE.md), and an activity that has already ended -- whose
    // token keeps returning 200 for its whole dismissal window while every push is discarded. A
    // relay log full of "sent" lines for a Live Activity that visibly stopped updating is exactly
    // the trap that made an app-side teardown bug read as a relay delivery problem for days. The
    // apns-id is logged alongside so a specific push can be looked up in Apple's delivery record.
    const payloadBytes = Buffer.byteLength(JSON.stringify(payload));
    console.log(`Activity ${event} payload for printer "${name}": ${payloadBytes} bytes ${JSON.stringify(redactImagesForLogging(payload))}`);
    // One push per device showing this print's Live Activity, not one per printer. Each device
    // has its own ActivityKit token and its own on-device liveactivitiesd budget, so a failure
    // against one says nothing about the others -- a dead token drops only that device.
    for (const device of deviceTokens) {
      try {
        const client = apnsClients[device.environment] || apnsClients.production;
        const result = await client.send({ token: device.token, environment: device.environment, payload, priority });
        if (result.shouldRemoveToken) {
          await activityTokenStore.removeToken(printerID, device.token);
          console.log(`Removed dead activity token (status ${result.status}) for printer "${name}" (token ${device.token})`);
        } else if (!result.ok) {
          console.error(`Activity ${event} send failed (status ${result.status}) for printer "${name}" (token ${device.token}): ${result.body}`);
        } else {
          console.log(`Activity ${event} accepted by APNs for printer "${name}" (progress=${progress ?? 'n/a'}, token ${device.token}, apns-id ${result.apnsId ?? 'n/a'})`);
        }
      } catch (error) {
        console.error(`Activity ${event} send threw for printer "${name}" (token ${device.token}):`, error);
      }
    }

    if (event === 'end') {
      await activityTokenStore.clearTokens(printerID);
      return;
    }

    // Some devices registered but not all of them: the ones above got their update, and the
    // missing ones get another wake once it's due. Counted after the sends so a token dropped as
    // dead just now counts as missing.
    const retry = wakeRetries.check(printerID, activityTokenStore.tokensFor(printerID).length);
    if (retry) {
      wakeRetries.recordWake(printerID);
      console.log(`Retrying background wake for printer "${name}" (${retry.reason}, attempt ${retry.attempt}/${retry.maxRetries})`);
      await sendBackgroundWake(name);
    }
  };

  // Polls Bambuddy's own API directly for start/pause/resume/finish/failed state transitions,
  // plus a periodic correction push (fresh estimatedEndAt etc.) on a fixed interval -- see
  // bambuddyPoller.js and
  // printerStateClassifier.js for the transition logic. Every ctx the poller hands to a callback
  // also carries issueSeverity/issueCount (see hmsIssues.js/hmsIssueDebouncer.js) -- the
  // severity-filtered, debounced replacement for the earlier naive "any new HMS code = Error"
  // version, which was confirmed live to be a false-positive source (see the design doc's "HMS
  // error -> Error update: disabled after a real false positive" section) and has since been
  // superseded by this badge instead of just staying disabled.
  const poller = new BambuddyPoller({
        bambuddyClient,
        intervalMs: config.bambuddyPollIntervalMs,
        correctionIntervalMs: config.liveActivityCorrectionIntervalMs,
        onStart: async ({ printerID, name, status, issueSeverity, issueCount, bambuddyPrinterId }) => {
          // Reset the previous print's retry state before anything here can throw (a failed
          // activity-tokens.json write, say) -- otherwise a print whose onStart failed would
          // inherit the last print's used-up retry cap and never get a wake retry at all. The
          // real expected-device count replaces the unknown one once push-to-start has gone out.
          wakeRetries.startPrint(printerID, null);
          await activityTokenStore.startPrint({ printerID, printerName: name, startedAt: new Date().toISOString() });
          const acceptedDevices = await sendPushToStart({ printerID, name, prefetchedStatus: status, issueSeverity, issueCount, bambuddyPrinterId });
          wakeRetries.startPrint(printerID, acceptedDevices);
          console.log(`Push-to-start accepted for ${acceptedDevices} device(s) for printer "${name}" -- waiting for that many activity tokens`);
        },
        onPause: async ({ printerID, name, status, issueSeverity, issueCount, bambuddyPrinterId }) =>
          sendActivityUpdate({ event: 'update', stateLabel: 'Paused', printerID, name, prefetchedStatus: status, issueSeverity, issueCount, bambuddyPrinterId }),
        onResume: async ({ printerID, name, status, issueSeverity, issueCount, bambuddyPrinterId }) =>
          sendActivityUpdate({ event: 'update', stateLabel: 'Printing', printerID, name, prefetchedStatus: status, issueSeverity, issueCount, bambuddyPrinterId }),
        onFinish: async ({ printerID, name, status, priorProgress, issueSeverity, issueCount, bambuddyPrinterId }) =>
          sendActivityUpdate({ event: 'end', stateLabel: 'Complete', printerID, name, prefetchedStatus: status, priorProgress, issueSeverity, issueCount, bambuddyPrinterId }),
        // Bambuddy's own frontend (PrintersPage.tsx's classifyPrinterStatus) treats a bare
        // FAILED gcode_state with no HMS error attached as equivalent to FINISH for GROUPING
        // purposes (badge/dot color) -- including user-cancellations, which report as FAILED
        // with nothing else distinguishing them from a genuine fault (see the design doc's
        // cancel-vs-failed investigation). That grouping bucket is not the same as what
        // Bambuddy displays as text, though: its separate getStatusDisplay still literally shows
        // "Failed" as the label regardless of bucket, only the color/grouping changes. So the
        // corrected wording here is "Stopped" -- not "Complete," which wrongly implies the print
        // succeeded -- for the common case (no real issue attached, i.e. a plain user stop or an
        // HMS-free failure); "Failed" is kept for when priorIssueSeverity shows a real qualifying
        // issue actually was confirmed active going into this transition.
        onFailed: async ({ printerID, name, status, priorIssueSeverity, priorProgress, issueSeverity, issueCount, bambuddyPrinterId }) =>
          sendActivityUpdate({
            event: 'end',
            stateLabel: priorIssueSeverity !== null ? 'Failed' : 'Stopped',
            printerID,
            name,
            prefetchedStatus: status,
            priorProgress,
            issueSeverity,
            issueCount,
            bambuddyPrinterId,
          }),
        // Routine corrections go out at apns-priority 5. Every Live Activity push was priority 10,
        // and at this deploy's ~30s correction cadence that is hundreds of high-priority pushes
        // per device per print against liveactivitiesd's private on-device budget (see
        // ARCHITECTURE.md) -- the budget whose exhaustion silently drops pushes APNs accepted,
        // i.e. a Live Activity frozen mid-print. Apple's guidance is to use priority 5 for updates
        // that aren't time-sensitive; start/pause/resume/end keep 10 so they land immediately.
        onCorrection: async ({ printerID, name, status, issueSeverity, issueCount, bambuddyPrinterId }) =>
          sendActivityUpdate({
            event: 'update',
            stateLabel: status.state === PAUSE ? 'Paused' : 'Printing',
            printerID,
            name,
            prefetchedStatus: status,
            issueSeverity,
            issueCount,
            bambuddyPrinterId,
            priority: 5,
          }),
        // An active printer Bambuddy has been unable to reach for the poller's disconnect window:
        // end the activity rather than leave it frozen on its last reading. If the printer comes
        // back still printing, the poller reports a fresh start and a new activity goes out.
        onDisconnected: async ({ printerID, name, status, priorProgress, bambuddyPrinterId }) =>
          sendActivityUpdate({
            event: 'end',
            stateLabel: 'Disconnected',
            printerID,
            name,
            prefetchedStatus: status,
            priorProgress,
            bambuddyPrinterId,
          }),
        // First reading after a (re)start with the printer idle/finished: if devices are still
        // registered for its activity, the print ended while the relay was down and no end push
        // ever went out. Send it now rather than leaving the Live Activity up until iOS expires it.
        onBaselineInactive: async ({ printerID, name, status, bambuddyPrinterId }) => {
          if (activityTokenStore.tokensFor(printerID).length === 0) return;
          console.log(`Printer "${name}" is ${status.state} at startup with an activity still registered -- sending the end push it missed`);
          await sendActivityUpdate({
            event: 'end',
            stateLabel: status.state === 'FINISH' ? 'Complete' : 'Stopped',
            printerID,
            name,
            prefetchedStatus: status,
            bambuddyPrinterId,
          });
        },
  });
  poller.start();
  console.log(`Polling Bambuddy every ${config.bambuddyPollIntervalMs}ms`);

  const app = createServer({ tokenStore, deviceTokenStore, activityTokenStore, authSecret: config.relayAuthSecret });
  const port = process.env.PORT || 3000;
  const server = http.createServer(app);
  server.listen(port, () => {
    console.log(`nozzlecast-relay listening on :${port}`);
  });

  const shutdown = () => {
    console.log('Shutting down...');
    poller.stop();
    apnsClients.sandbox.close();
    apnsClients.production.close();
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

module.exports = { main, redactImagesForLogging, wakeTargets };

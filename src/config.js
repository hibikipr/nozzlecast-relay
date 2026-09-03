const REQUIRED_VARS = [
  'NTFY_SERVER',
  'NTFY_TOPIC',
  'NTFY_AUTH_TOKEN',
  'RELAY_AUTH_SECRET',
  'APNS_KEY_PATH',
  'APNS_KEY_ID',
  'APNS_SANDBOX_KEY_PATH',
  'APNS_SANDBOX_KEY_ID',
  'APNS_TEAM_ID',
  'APNS_BUNDLE_ID',
  'BAMBUDDY_URL',
  'BAMBUDDY_API_KEY',
];

function loadConfig(env = process.env) {
  const missing = REQUIRED_VARS.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }

  return {
    ntfyServer: env.NTFY_SERVER.replace(/\/$/, ''),
    ntfyTopic: env.NTFY_TOPIC,
    ntfyAuthToken: env.NTFY_AUTH_TOKEN,
    relayAuthSecret: env.RELAY_AUTH_SECRET,
    // Apple APNs auth keys are ordinarily environment-agnostic (one key works against both
    // api.push.apple.com and api.sandbox.push.apple.com) -- but confirmed empirically against a
    // real deploy that this is not universally true: a key scoped to production got a 403
    // BadEnvironmentKeyInToken (an auth-tier rejection) when its JWT was presented to the
    // sandbox host, while the exact same JWT sent to the production host got the normal
    // token-tier 400 BadDeviceToken. So this supports two distinct (path, keyId) pairs rather
    // than assuming one key covers both.
    apnsKeyPath: env.APNS_KEY_PATH,
    apnsKeyId: env.APNS_KEY_ID,
    apnsSandboxKeyPath: env.APNS_SANDBOX_KEY_PATH,
    apnsSandboxKeyId: env.APNS_SANDBOX_KEY_ID,
    apnsTeamId: env.APNS_TEAM_ID,
    apnsBundleId: env.APNS_BUNDLE_ID,
    apnsTopic: `${env.APNS_BUNDLE_ID}.push-type.liveactivity`,
    // Recommended to be a dedicated, read-only Bambuddy API key (Bambuddy supports scoped keys
    // independent of print-control/queue permissions) -- the relay only ever reads printer
    // status to enrich a Live Activity, it never needs to control anything.
    bambuddyUrl: env.BAMBUDDY_URL.replace(/\/$/, ''),
    bambuddyApiKey: env.BAMBUDDY_API_KEY,
    // Two independent, optional trigger toggles -- both can run at once (not the intended
    // steady state, but not actively guarded against either), and the code for both stays in
    // place regardless of which is enabled. NTFY_TRIGGER_ENABLED defaults to true (unset =
    // today's existing behavior, so nothing changes for a deploy that predates this option);
    // BAMBUDDY_POLL_TRIGGER_ENABLED defaults to false (opt-in, since it's the newer, less-proven
    // path -- see printerStateClassifier.js's note on the unconfirmed PAUSE state value).
    ntfyTriggerEnabled: env.NTFY_TRIGGER_ENABLED !== 'false',
    bambuddyPollTriggerEnabled: env.BAMBUDDY_POLL_TRIGGER_ENABLED === 'true',
    bambuddyPollIntervalMs: Number(env.BAMBUDDY_POLL_INTERVAL_MS) || 15000,
    // How often to send a correction update (fresh estimatedEndAt etc.) to an active print with
    // no other event to report -- decouples the update cadence from Bambuddy's own ntfy
    // milestone notifications (25/50/75%) entirely, per the design's intent to rely on
    // ActivityKit's own native countdown timer UI between corrections rather than pushing on
    // every percentage milestone.
    liveActivityCorrectionIntervalMs: Number(env.LIVE_ACTIVITY_CORRECTION_INTERVAL_MS) || 10 * 60 * 1000,
    dataDir: env.DATA_DIR || '/data',
  };
}

module.exports = { loadConfig };

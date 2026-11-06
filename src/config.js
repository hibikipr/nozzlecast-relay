const { parseAccessCodes } = require('./printerCover');

const REQUIRED_VARS = [
  'RELAY_AUTH_SECRET',
  'BAMBUDDY_URL',
  'BAMBUDDY_API_KEY',
];

// Apple push keys: all of them or none. Without them the relay runs with no APNs at all: no Live
// Activities, and Bambuddy's alerts are kept for the app to fetch (GET /alerts) rather than pushed.
const APNS_VARS = [
  'APNS_KEY_PATH',
  'APNS_KEY_ID',
  'APNS_SANDBOX_KEY_PATH',
  'APNS_SANDBOX_KEY_ID',
  'APNS_TEAM_ID',
  'APNS_BUNDLE_ID',
];

function loadConfig(env = process.env) {
  const missing = REQUIRED_VARS.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
  const apnsSet = APNS_VARS.filter((key) => env[key]);
  if (apnsSet.length > 0 && apnsSet.length < APNS_VARS.length) {
    const apnsMissing = APNS_VARS.filter((key) => !env[key]);
    throw new Error(`Apple push keys are set only in part: missing ${apnsMissing.join(', ')}. Set all of ${APNS_VARS.join(', ')}, or none to run without push.`);
  }
  const apnsEnabled = apnsSet.length === APNS_VARS.length;

  return {
    relayAuthSecret: env.RELAY_AUTH_SECRET,
    apnsEnabled,
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
    apnsBundleId: env.APNS_BUNDLE_ID || null,
    apnsTopic: apnsEnabled ? `${env.APNS_BUNDLE_ID}.push-type.liveactivity` : null,
    // Recommended to be a dedicated, read-only Bambuddy API key (Bambuddy supports scoped keys
    // independent of print-control/queue permissions) -- the relay only ever reads printer
    // status to enrich a Live Activity, it never needs to control anything.
    bambuddyUrl: env.BAMBUDDY_URL.replace(/\/$/, ''),
    bambuddyApiKey: env.BAMBUDDY_API_KEY,
    // Polling Bambuddy's own API is the only trigger. It replaced an ntfy/SSE trigger that
    // detected prints by regex-parsing Bambuddy's own alert titles: that could only ever see the
    // events Bambuddy chose to notify on (start, 25/50/75%, end), never a pause, a resume, or a
    // real HMS issue, and it had no way to drive a correction on its own schedule.
    bambuddyPollIntervalMs: Number(env.BAMBUDDY_POLL_INTERVAL_MS) || 15000,
    // How often to send a correction update (fresh estimatedEndAt etc.) to an active print with
    // no other event to report. The design deliberately relies on ActivityKit's own native
    // countdown-timer UI between corrections rather than pushing on every percentage milestone.
    liveActivityCorrectionIntervalMs: Number(env.LIVE_ACTIVITY_CORRECTION_INTERVAL_MS) || 10 * 60 * 1000,
    // Off by default: push-to-start subscribes each new activity to a per-print broadcast channel
    // (iOS 18+) and updates are published there. It needs Broadcast enabled for the App ID in the
    // Apple Developer portal; without it channel creation fails and each print falls back to
    // per-activity tokens.
    liveActivityChannels: env.LIVE_ACTIVITY_CHANNELS === 'true',
    // Optional: "<serial or printer name>:<LAN access code>" pairs, comma-separated. With a
    // printer's code the relay reads a cover Bambuddy can't find (an HTTPS-dispatched print, a job name with
    // a "/") straight off the printer over FTPS. Bambuddy never hands access codes to an API key,
    // so they can't come from there.
    printerAccessCodes: parseAccessCodes(env.PRINTER_ACCESS_CODES),
    // Optional second key for GET /cover only, so a dashboard or display can show covers without
    // holding RELAY_AUTH_SECRET, which also registers push tokens.
    coverApiKey: env.COVER_API_KEY || null,
    dataDir: env.DATA_DIR || '/data',
  };
}

module.exports = { loadConfig };

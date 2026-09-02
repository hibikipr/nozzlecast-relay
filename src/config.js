const REQUIRED_VARS = [
  'NTFY_SERVER',
  'NTFY_TOPIC',
  'NTFY_AUTH_TOKEN',
  'RELAY_AUTH_SECRET',
  'APNS_KEY_PATH',
  'APNS_KEY_ID',
  'APNS_TEAM_ID',
  'APNS_BUNDLE_ID',
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
    apnsKeyPath: env.APNS_KEY_PATH,
    apnsKeyId: env.APNS_KEY_ID,
    apnsTeamId: env.APNS_TEAM_ID,
    apnsBundleId: env.APNS_BUNDLE_ID,
    apnsTopic: `${env.APNS_BUNDLE_ID}.push-type.liveactivity`,
    dataDir: env.DATA_DIR || '/data',
  };
}

module.exports = { loadConfig };

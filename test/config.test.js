const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');

const FULL_ENV = {
  NTFY_SERVER: 'https://ntfy.townsville.cc',
  NTFY_TOPIC: 'townsville-3dprinter',
  NTFY_AUTH_TOKEN: 'tk_test',
  RELAY_AUTH_SECRET: 'secret123',
  APNS_KEY_PATH: '/secrets/AuthKey_TEST.p8',
  APNS_KEY_ID: 'ABC123',
  APNS_SANDBOX_KEY_PATH: '/secrets/AuthKey_SANDBOX_TEST.p8',
  APNS_SANDBOX_KEY_ID: 'DEF456',
  APNS_TEAM_ID: '89863526TH',
  APNS_BUNDLE_ID: 'com.victormanuel.NozzleCast',
  BAMBUDDY_URL: 'https://bambuddy.townsville.cc',
  BAMBUDDY_API_KEY: 'bb_test',
};

test('loadConfig returns normalized config when all vars present', () => {
  const config = loadConfig(FULL_ENV);
  assert.equal(config.ntfyServer, 'https://ntfy.townsville.cc');
  assert.equal(config.ntfyTopic, 'townsville-3dprinter');
  assert.equal(config.ntfyAuthToken, 'tk_test');
  assert.equal(config.relayAuthSecret, 'secret123');
  assert.equal(config.apnsKeyPath, '/secrets/AuthKey_TEST.p8');
  assert.equal(config.apnsKeyId, 'ABC123');
  assert.equal(config.apnsSandboxKeyPath, '/secrets/AuthKey_SANDBOX_TEST.p8');
  assert.equal(config.apnsSandboxKeyId, 'DEF456');
  assert.equal(config.apnsTeamId, '89863526TH');
  assert.equal(config.apnsBundleId, 'com.victormanuel.NozzleCast');
  assert.equal(config.apnsTopic, 'com.victormanuel.NozzleCast.push-type.liveactivity');
  assert.equal(config.bambuddyUrl, 'https://bambuddy.townsville.cc');
  assert.equal(config.bambuddyApiKey, 'bb_test');
  assert.equal(config.ntfyTriggerEnabled, true);
  assert.equal(config.bambuddyPollTriggerEnabled, false);
  assert.equal(config.bambuddyPollIntervalMs, 15000);
  assert.equal(config.liveActivityCorrectionIntervalMs, 10 * 60 * 1000);
  assert.equal(config.dataDir, '/data');
});

test('loadConfig defaults NTFY_TRIGGER_ENABLED to true when unset (preserves pre-existing behavior)', () => {
  const config = loadConfig(FULL_ENV);
  assert.equal(config.ntfyTriggerEnabled, true);
});

test('loadConfig disables the ntfy trigger only on an explicit "false"', () => {
  assert.equal(loadConfig({ ...FULL_ENV, NTFY_TRIGGER_ENABLED: 'false' }).ntfyTriggerEnabled, false);
  assert.equal(loadConfig({ ...FULL_ENV, NTFY_TRIGGER_ENABLED: 'anything-else' }).ntfyTriggerEnabled, true);
});

test('loadConfig enables the Bambuddy poll trigger only on an explicit "true"', () => {
  assert.equal(loadConfig({ ...FULL_ENV, BAMBUDDY_POLL_TRIGGER_ENABLED: 'true' }).bambuddyPollTriggerEnabled, true);
  assert.equal(loadConfig({ ...FULL_ENV, BAMBUDDY_POLL_TRIGGER_ENABLED: 'yes' }).bambuddyPollTriggerEnabled, false);
});

test('loadConfig respects BAMBUDDY_POLL_INTERVAL_MS and LIVE_ACTIVITY_CORRECTION_INTERVAL_MS overrides', () => {
  const config = loadConfig({
    ...FULL_ENV,
    BAMBUDDY_POLL_INTERVAL_MS: '5000',
    LIVE_ACTIVITY_CORRECTION_INTERVAL_MS: '300000',
  });
  assert.equal(config.bambuddyPollIntervalMs, 5000);
  assert.equal(config.liveActivityCorrectionIntervalMs, 300000);
});

test('loadConfig strips a trailing slash from NTFY_SERVER', () => {
  const config = loadConfig({ ...FULL_ENV, NTFY_SERVER: 'https://ntfy.townsville.cc/' });
  assert.equal(config.ntfyServer, 'https://ntfy.townsville.cc');
});

test('loadConfig strips a trailing slash from BAMBUDDY_URL', () => {
  const config = loadConfig({ ...FULL_ENV, BAMBUDDY_URL: 'https://bambuddy.townsville.cc/' });
  assert.equal(config.bambuddyUrl, 'https://bambuddy.townsville.cc');
});

test('loadConfig respects DATA_DIR override', () => {
  const config = loadConfig({ ...FULL_ENV, DATA_DIR: '/custom/data' });
  assert.equal(config.dataDir, '/custom/data');
});

test('loadConfig throws listing every missing required var', () => {
  const { NTFY_SERVER, RELAY_AUTH_SECRET, ...partial } = FULL_ENV;
  assert.throws(
    () => loadConfig(partial),
    /Missing required env vars: NTFY_SERVER, RELAY_AUTH_SECRET/
  );
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');

const FULL_ENV = {
  NTFY_SERVER: 'https://ntfy.example.com',
  NTFY_TOPIC: '3dprinter-alerts',
  NTFY_AUTH_TOKEN: 'tk_test',
  RELAY_AUTH_SECRET: 'secret123',
  APNS_KEY_PATH: '/secrets/AuthKey_TEST.p8',
  APNS_KEY_ID: 'ABC123',
  APNS_SANDBOX_KEY_PATH: '/secrets/AuthKey_SANDBOX_TEST.p8',
  APNS_SANDBOX_KEY_ID: 'DEF456',
  APNS_TEAM_ID: 'ABCDE12345',
  APNS_BUNDLE_ID: 'com.example.NozzleCast',
  BAMBUDDY_URL: 'https://bambuddy.example.com',
  BAMBUDDY_API_KEY: 'bb_test',
};

test('loadConfig returns normalized config when all vars present', () => {
  const config = loadConfig(FULL_ENV);
  assert.equal(config.ntfyServer, 'https://ntfy.example.com');
  assert.equal(config.ntfyTopic, '3dprinter-alerts');
  assert.equal(config.ntfyAuthToken, 'tk_test');
  assert.equal(config.relayAuthSecret, 'secret123');
  assert.equal(config.apnsKeyPath, '/secrets/AuthKey_TEST.p8');
  assert.equal(config.apnsKeyId, 'ABC123');
  assert.equal(config.apnsSandboxKeyPath, '/secrets/AuthKey_SANDBOX_TEST.p8');
  assert.equal(config.apnsSandboxKeyId, 'DEF456');
  assert.equal(config.apnsTeamId, 'ABCDE12345');
  assert.equal(config.apnsBundleId, 'com.example.NozzleCast');
  assert.equal(config.apnsTopic, 'com.example.NozzleCast.push-type.liveactivity');
  assert.equal(config.bambuddyUrl, 'https://bambuddy.example.com');
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
  const config = loadConfig({ ...FULL_ENV, NTFY_SERVER: 'https://ntfy.example.com/' });
  assert.equal(config.ntfyServer, 'https://ntfy.example.com');
});

test('loadConfig strips a trailing slash from BAMBUDDY_URL', () => {
  const config = loadConfig({ ...FULL_ENV, BAMBUDDY_URL: 'https://bambuddy.example.com/' });
  assert.equal(config.bambuddyUrl, 'https://bambuddy.example.com');
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

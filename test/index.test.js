const { test } = require('node:test');
const assert = require('node:assert');
const { redactImagesForLogging } = require('../src/index');

test('redactImagesForLogging replaces coverImage and liveSnapshot with a length marker', () => {
  const payload = {
    aps: {
      event: 'start',
      'content-state': {
        coverImage: 'aGVsbG8=',
        liveSnapshot: 'd29ybGQ=',
        progress: 0.5,
      },
      'attributes-type': 'NozzleCastShared.PrintActivityAttributes',
    },
  };

  const redacted = redactImagesForLogging(payload);

  assert.equal(redacted.aps['content-state'].coverImage, '<base64, 8 chars>');
  assert.equal(redacted.aps['content-state'].liveSnapshot, '<base64, 8 chars>');
  assert.equal(redacted.aps['content-state'].progress, 0.5);
  assert.equal(redacted.aps['attributes-type'], 'NozzleCastShared.PrintActivityAttributes');
});

test('redactImagesForLogging leaves payloads with no images untouched', () => {
  const payload = { aps: { event: 'start', 'content-state': { progress: 0 } } };
  const redacted = redactImagesForLogging(payload);
  assert.deepEqual(redacted, payload);
});

test('redactImagesForLogging does not mutate the original payload', () => {
  const payload = { aps: { 'content-state': { coverImage: 'aGVsbG8=' } } };
  redactImagesForLogging(payload);
  assert.equal(payload.aps['content-state'].coverImage, 'aGVsbG8=');
});

const { wakeTargets } = require('../src/index');

test('wakeTargets skips device tokens in an environment with no push-to-start token', () => {
  const p2s = [{ token: 'p1', environment: 'production' }, { token: 'p2', environment: 'production' }];
  const devices = [
    { token: 'd1', environment: 'production' },
    { token: 'd2', environment: 'sandbox' },
    { token: 'd3', environment: 'sandbox' },
  ];
  assert.deepEqual(wakeTargets(p2s, devices).map((entry) => entry.token), ['d1']);
});

test('wakeTargets keeps both environments when both have push-to-start tokens', () => {
  const p2s = [{ token: 'p1', environment: 'production' }, { token: 'p2', environment: 'sandbox' }];
  const devices = [{ token: 'd1', environment: 'production' }, { token: 'd2', environment: 'sandbox' }];
  assert.equal(wakeTargets(p2s, devices).length, 2);
});

test('wakeTargets wakes every device when there is no push-to-start token to filter by', () => {
  const devices = [{ token: 'd1', environment: 'production' }, { token: 'd2', environment: 'sandbox' }];
  assert.equal(wakeTargets([], devices).length, 2);
});

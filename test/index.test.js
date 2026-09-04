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

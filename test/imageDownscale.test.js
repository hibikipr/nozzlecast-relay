const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { downscaleImage } = require('../src/imageDownscale');

// Solid-color images compress trivially at any quality; a random-noise image is what actually
// forces the quality-reduction loop to engage, since JPEG can't compress noise anywhere near as
// well as a flat color.
function solidImage(width, height) {
  return sharp({ create: { width, height, channels: 3, background: { r: 100, g: 150, b: 200 } } })
    .png()
    .toBuffer();
}

function noiseImage(width, height) {
  const bytes = Buffer.alloc(width * height * 3);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return sharp(bytes, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

test('downscaleImage resizes to the real target pixel dimensions, no upscale', async () => {
  const source = await solidImage(512, 512);
  const result = await downscaleImage(source, { maxDimension: 36, maxBytes: 1000 });

  assert.ok(result);
  const meta = await sharp(result).metadata();
  assert.equal(meta.width, 36);
  assert.equal(meta.height, 36);
  assert.equal(meta.format, 'jpeg');
});

test('downscaleImage never upscales a source smaller than maxDimension', async () => {
  const source = await solidImage(20, 10);
  const result = await downscaleImage(source, { maxDimension: 36, maxBytes: 1000 });

  const meta = await sharp(result).metadata();
  assert.equal(meta.width, 20);
  assert.equal(meta.height, 10);
});

test('downscaleImage preserves aspect ratio when scaling a non-square source', async () => {
  const source = await solidImage(1280, 720);
  const result = await downscaleImage(source, { maxDimension: 40, maxBytes: 1300 });

  const meta = await sharp(result).metadata();
  assert.equal(meta.width, 40);
  assert.equal(meta.height, Math.round(720 * (40 / 1280)));
});

test('downscaleImage stays under maxBytes for an easily-compressible image', async () => {
  const source = await solidImage(512, 512);
  const result = await downscaleImage(source, { maxDimension: 36, maxBytes: 1000 });

  assert.ok(result.length <= 1000);
});

test('downscaleImage steps quality down when quality 0.5 doesn\'t fit the budget', async () => {
  const source = await noiseImage(200, 200);
  // A 36x36 noise image measured (across several runs) ~404-414B at quality 0.5 and
  // ~336-347B at quality 0.3 -- 390 reliably sits between the two (never satisfied at 0.5,
  // always satisfied by 0.3), so hitting budget requires the loop to actually step quality
  // down, not just succeed on the first attempt.
  const result = await downscaleImage(source, { maxDimension: 36, maxBytes: 390 });

  assert.ok(result, 'expected a result at some quality step, not an immediate floor failure');
  assert.ok(result.length <= 390);
});

test('downscaleImage returns null when even the quality floor is over budget', async () => {
  const source = await noiseImage(200, 200);
  const result = await downscaleImage(source, { maxDimension: 36, maxBytes: 1 });

  assert.equal(result, null);
});

test('downscaleImage picks the best quality that fits, not just the first one under budget', async () => {
  // Regression test for a real bug: the quality-search loop used to start at 0.5 and return
  // immediately, so a photo that already fit comfortably at 0.5 (most tiny 36-40px thumbnails do)
  // never got a chance at 0.6-0.95 -- routinely leaving 60%+ of the already-safe, already-budgeted
  // byte allowance unused and looking needlessly pixelated for no size-budget benefit. A real
  // 1280x720 camera frame downscaled to 40px measured 466B at quality 0.5 vs 906B at quality
  // 0.95 (maxBytes 1300) -- so "does the loop settle for the old low-quality byte count when a
  // much better one still fits" is a real, previously-failing assertion, not a hypothetical one.
  const source = await noiseImage(400, 400);
  const lowQualityReference = await sharp(source).resize(40, 40).jpeg({ quality: 50 }).toBuffer();
  const generousBudget = lowQualityReference.length * 3;

  const result = await downscaleImage(source, { maxDimension: 40, maxBytes: generousBudget });

  assert.ok(result.length <= generousBudget);
  assert.ok(
    result.length > lowQualityReference.length,
    `expected a higher-quality (larger) result than the old quality=0.5 starting point (${lowQualityReference.length}B) when ${generousBudget}B was available, got ${result.length}B`,
  );
});

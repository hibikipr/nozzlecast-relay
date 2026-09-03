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

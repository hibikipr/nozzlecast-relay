const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { downscaleCover, BACKDROP_DARK, BACKDROP_LIGHT } = require('../src/imageDownscale');

// Solid-color images compress trivially at any quality; a random-noise image is what actually
// forces the quality-reduction loop to engage, since WebP can't compress noise anywhere near as
// well as a flat color.
function solidImage(width, height, color = { r: 100, g: 150, b: 200 }) {
  return sharp({ create: { width, height, channels: 3, background: color } })
    .png()
    .toBuffer();
}

function noiseImage(width, height) {
  const bytes = Buffer.alloc(width * height * 3);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return sharp(bytes, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

const transparent = { r: 0, g: 0, b: 0, alpha: 0 };

// A cover render as Bambu exports it: the model in the middle of a mostly transparent canvas.
function modelOnTransparent({ canvas = 200, modelWidth = 50, modelHeight = 100, color }) {
  const model = { create: { width: modelWidth, height: modelHeight, channels: 4, background: { ...color, alpha: 1 } } };
  return sharp({ create: { width: canvas, height: canvas, channels: 4, background: transparent } })
    .composite([{ input: model, left: (canvas - modelWidth) / 2, top: (canvas - modelHeight) / 2 }])
    .png()
    .toBuffer();
}

// An L-shaped model, so the trimmed image keeps a transparent (backdrop) top-right corner.
async function lShapedModel(color) {
  // The model spans x 70-130, y 50-150; cutting out its top-right quarter leaves an L.
  const block = await modelOnTransparent({ canvas: 200, modelWidth: 60, modelHeight: 100, color });
  return sharp(block)
    .composite([{ input: { create: { width: 30, height: 50, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }, left: 100, top: 50, blend: 'dest-out' }])
    .png()
    .toBuffer();
}

async function topRightPixel(buffer) {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const offset = (info.width - 1) * info.channels;
  return [data[offset], data[offset + 1], data[offset + 2]];
}

function hexToRgb(hex) {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function assertNear(actual, expected, label) {
  actual.forEach((channel, index) => {
    assert.ok(Math.abs(channel - expected[index]) <= 10, `${label}: expected ~${expected}, got ${actual}`);
  });
}

test('downscaleCover encodes WebP sized to maxDimension', async () => {
  const source = await solidImage(512, 512);
  const result = await downscaleCover(source, { maxDimension: 96, maxBytes: 2200 });

  assert.ok(result);
  const meta = await sharp(result).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.width, 96);
  assert.equal(meta.height, 96);
});

test('downscaleCover never upscales a source smaller than maxDimension', async () => {
  const source = await solidImage(20, 10);
  const result = await downscaleCover(source, { maxDimension: 96, maxBytes: 2200 });

  const meta = await sharp(result).metadata();
  assert.equal(meta.width, 20);
  assert.equal(meta.height, 10);
});

test('downscaleCover trims the transparent margin so the model fills the image', async () => {
  // Regression for the blur: a real 512x512 render's model spans only 184x215, so without the
  // trim most of the tiny budget went on empty canvas.
  const source = await modelOnTransparent({ modelWidth: 50, modelHeight: 100, color: { r: 200, g: 60, b: 60 } });
  const result = await downscaleCover(source, { maxDimension: 96, maxBytes: 2200 });

  const meta = await sharp(result).metadata();
  assert.equal(meta.height, 96);
  assert.equal(meta.width, 48);
});

test('downscaleCover puts a dark model on the light backdrop', async () => {
  // Regression for a real cover: a dark filament model vanished when its transparency became
  // black, and a fixed mid-grey hid grey models instead -- the backdrop has to follow the model.
  const result = await downscaleCover(await lShapedModel({ r: 40, g: 30, b: 90 }), { maxDimension: 96, maxBytes: 2200 });

  assertNear(await topRightPixel(result), hexToRgb(BACKDROP_LIGHT), 'backdrop behind a dark model');
});

test('downscaleCover puts a light model on the dark backdrop', async () => {
  const result = await downscaleCover(await lShapedModel({ r: 170, g: 170, b: 170 }), { maxDimension: 96, maxBytes: 2200 });

  assertNear(await topRightPixel(result), hexToRgb(BACKDROP_DARK), 'backdrop behind a light model');
});

test('downscaleCover stays under maxBytes for an easily-compressible image', async () => {
  const source = await solidImage(512, 512);
  const result = await downscaleCover(source, { maxDimension: 96, maxBytes: 2200 });

  assert.ok(result.length <= 2200);
});

test('downscaleCover steps quality down when the top quality doesn\'t fit the budget', async () => {
  const source = await noiseImage(200, 200);
  const topQuality = await sharp(source).resize(96, 96).webp({ quality: 95 }).toBuffer();
  const budget = Math.floor(topQuality.length * 0.6);

  const result = await downscaleCover(source, { maxDimension: 96, maxBytes: budget });

  assert.ok(result, 'expected a result at some quality step, not an immediate floor failure');
  assert.ok(result.length <= budget);
});

test('downscaleCover returns null when even the quality floor is over budget', async () => {
  const source = await noiseImage(200, 200);
  const result = await downscaleCover(source, { maxDimension: 96, maxBytes: 1 });

  assert.equal(result, null);
});

test('downscaleCover picks the best quality that fits, not just the first one under budget', async () => {
  const source = await noiseImage(400, 400);
  const lowQualityReference = await sharp(source).resize(96, 96).webp({ quality: 50 }).toBuffer();
  const generousBudget = lowQualityReference.length * 3;

  const result = await downscaleCover(source, { maxDimension: 96, maxBytes: generousBudget });

  assert.ok(result.length <= generousBudget);
  assert.ok(
    result.length > lowQualityReference.length,
    `expected a higher-quality (larger) result than quality=50 (${lowQualityReference.length}B) when ${generousBudget}B was available, got ${result.length}B`,
  );
});

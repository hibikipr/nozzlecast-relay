const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { renderCover, parseRenderOptions, InvalidRenderOptions } = require('../src/coverRender');

// A 512x512 render on a transparent background, like Bambu's plate_N.png.
async function platePng({ fill = '#ff0000', width = 200, height = 200 } = {}) {
  return sharp({ create: { width: 512, height: 512, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: Buffer.from(`<svg width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="${fill}"/></svg>`), top: 156, left: 156 }])
    .png()
    .toBuffer();
}

async function pixel(body, x, y) {
  const { data, info } = await sharp(body).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * info.channels;
  return [data[offset], data[offset + 1], data[offset + 2]];
}

function near([r, g, b], hex, tolerance = 12) {
  const [er, eg, eb] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return Math.abs(r - er) <= tolerance && Math.abs(g - eg) <= tolerance && Math.abs(b - eb) <= tolerance;
}

test('with no options the PNG comes back at full size', async () => {
  const rendered = await renderCover(await platePng());
  assert.equal(rendered.contentType, 'image/png');
  assert.deepEqual([rendered.width, rendered.height], [512, 512]);
});

test('a size fits the image inside the box without stretching or enlarging', async () => {
  const png = await platePng();
  const fitted = await renderCover(png, { width: 160, height: 120 });
  assert.deepEqual([fitted.width, fitted.height], [120, 120]);
  const notEnlarged = await renderCover(png, { width: 1000 });
  assert.deepEqual([notEnlarged.width, notEnlarged.height], [512, 512]);
});

test('jpeg is baseline, flattened onto the asked-for background', async () => {
  const rendered = await renderCover(await platePng(), { width: 100, format: 'jpeg', background: '#ffffff' });
  assert.equal(rendered.contentType, 'image/jpeg');
  const metadata = await sharp(rendered.body).metadata();
  assert.equal(metadata.isProgressive, false);
  const { data } = await sharp(rendered.body).raw().toBuffer({ resolveWithObject: true });
  assert.ok(data[0] > 240 && data[1] > 240 && data[2] > 240, 'corner should be the white background');
});

test('rgb565 is two bytes a pixel, little-endian, with no header', async () => {
  const rendered = await renderCover(await platePng(), { width: 64, format: 'rgb565', background: '#0000ff' });
  assert.equal(rendered.contentType, 'application/octet-stream');
  assert.deepEqual([rendered.width, rendered.height], [64, 64]);
  assert.equal(rendered.body.length, 64 * 64 * 2);
  assert.equal(rendered.body.readUInt16LE(0), 0x001f); // blue background corner
  assert.equal(rendered.body.readUInt16LE((32 * 64 + 32) * 2), 0xf800); // red centre
});

test('bg auto trims to the model and puts a light one on the dark backdrop', async () => {
  const rendered = await renderCover(await platePng({ fill: '#f0f0f0', width: 100, height: 200 }), { width: 120, height: 120, format: 'jpeg', background: 'auto' });
  assert.deepEqual([rendered.width, rendered.height], [120, 120]);
  assert.ok(near(await pixel(rendered.body, 0, 0), '#1f2329'), 'corner should be the dark backdrop');
  assert.ok(near(await pixel(rendered.body, 60, 60), '#f0f0f0'), 'trimmed model should fill the middle');
});

test('bg auto puts a dark model on the light backdrop', async () => {
  const rendered = await renderCover(await platePng({ fill: '#202020', width: 100, height: 200 }), { width: 120, height: 120, format: 'rgb565', background: 'auto' });
  const [r, g, b] = [rendered.body.readUInt16LE(0)].map((v) => [(v >> 11) << 3, ((v >> 5) & 0x3f) << 2, (v & 0x1f) << 3])[0];
  assert.ok(near([r, g, b], '#c4c9d1', 10), 'corner should be the light backdrop');
});

test('bg auto pads a model smaller than the box out to the box', async () => {
  const rendered = await renderCover(await platePng({ width: 40, height: 60 }), { width: 120, height: 120, format: 'png', background: 'auto' });
  assert.deepEqual([rendered.width, rendered.height], [120, 120]);
  assert.ok(near(await pixel(rendered.body, 0, 0), '#c4c9d1'), 'padding should be the backdrop');
});

test('query options are parsed, with defaults', () => {
  assert.deepEqual(parseRenderOptions({}), { width: null, height: null, format: 'png', quality: 80, background: '#000000' });
  assert.deepEqual(parseRenderOptions({ width: '240', format: 'jpg', quality: '70', bg: '1A2B3C' }), {
    width: 240, height: null, format: 'jpeg', quality: 70, background: '#1A2B3C',
  });
  assert.equal(parseRenderOptions({ bg: 'auto' }).background, 'auto');
});

test('bad query options are rejected', () => {
  for (const query of [{ width: '0' }, { width: '9999' }, { height: '1.5' }, { format: 'gif' }, { quality: '101' }, { bg: 'red' }]) {
    assert.throws(() => parseRenderOptions(query), InvalidRenderOptions, JSON.stringify(query));
  }
});

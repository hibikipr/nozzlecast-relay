const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { renderCover, parseRenderOptions, InvalidRenderOptions } = require('../src/coverRender');

// A 512x512 render on a transparent background, like Bambu's plate_N.png.
async function platePng() {
  return sharp({ create: { width: 512, height: 512, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: Buffer.from('<svg width="200" height="200"><rect width="200" height="200" fill="#ff0000"/></svg>'), top: 156, left: 156 }])
    .png()
    .toBuffer();
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

test('query options are parsed, with defaults', () => {
  assert.deepEqual(parseRenderOptions({}), { width: null, height: null, format: 'png', quality: 80, background: '#000000' });
  assert.deepEqual(parseRenderOptions({ width: '240', format: 'jpg', quality: '70', bg: '1A2B3C' }), {
    width: 240, height: null, format: 'jpeg', quality: 70, background: '#1A2B3C',
  });
});

test('bad query options are rejected', () => {
  for (const query of [{ width: '0' }, { width: '9999' }, { height: '1.5' }, { format: 'gif' }, { quality: '101' }, { bg: 'red' }]) {
    assert.throws(() => parseRenderOptions(query), InvalidRenderOptions, JSON.stringify(query));
  }
});

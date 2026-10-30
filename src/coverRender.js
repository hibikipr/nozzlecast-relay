const sharp = require('sharp');

const MAX_DIMENSION = 2048;

class InvalidRenderOptions extends Error {}

function parseDimension(value, name) {
  if (value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_DIMENSION) {
    throw new InvalidRenderOptions(`${name} must be a whole number from 1 to ${MAX_DIMENSION}`);
  }
  return number;
}

// Render options from a /cover request's query string. Throws InvalidRenderOptions on a bad one.
//   width, height  fit the image inside this box, keeping its aspect ratio (never enlarged)
//   format         png (default) | jpeg | rgb565
//   quality        JPEG quality 1-100, default 80
//   bg             RRGGBB the transparent background is flattened onto (jpeg/rgb565), default 000000
function parseRenderOptions(query) {
  const format = query.format || 'png';
  if (!['png', 'jpeg', 'jpg', 'rgb565'].includes(format)) {
    throw new InvalidRenderOptions('format must be png, jpeg or rgb565');
  }
  const quality = query.quality === undefined ? 80 : Number(query.quality);
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
    throw new InvalidRenderOptions('quality must be a whole number from 1 to 100');
  }
  const background = query.bg ?? '000000';
  if (!/^[0-9a-fA-F]{6}$/.test(background)) throw new InvalidRenderOptions('bg must be RRGGBB hex');
  return {
    width: parseDimension(query.width, 'width'),
    height: parseDimension(query.height, 'height'),
    format: format === 'jpg' ? 'jpeg' : format,
    quality,
    background: `#${background}`,
  };
}

// The cover PNG rendered as asked. Returns { body, contentType, width, height }.
//
// jpeg is baseline (not progressive), which the small decoders on microcontrollers (TJpgDec,
// JPEGDEC) need. rgb565 is raw 16-bit pixels, little-endian, row by row with no header -- what an
// ESP32 display driver can push straight to the panel; the X-Image-Width/-Height headers carry
// its size.
async function renderCover(png, { width = null, height = null, format = 'png', quality = 80, background = '#000000' } = {}) {
  let image = sharp(png);
  if (width || height) image = image.resize(width, height, { fit: 'inside', withoutEnlargement: true });

  if (format === 'png') {
    const { data, info } = await image.png().toBuffer({ resolveWithObject: true });
    return { body: data, contentType: 'image/png', width: info.width, height: info.height };
  }

  image = image.flatten({ background });
  if (format === 'jpeg') {
    const { data, info } = await image.jpeg({ quality, progressive: false, chromaSubsampling: '4:2:0' })
      .toBuffer({ resolveWithObject: true });
    return { body: data, contentType: 'image/jpeg', width: info.width, height: info.height };
  }

  const { data, info } = await image.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixels = Buffer.alloc(info.width * info.height * 2);
  for (let i = 0, o = 0; i < data.length; i += info.channels, o += 2) {
    pixels.writeUInt16LE(((data[i] & 0xf8) << 8) | ((data[i + 1] & 0xfc) << 3) | (data[i + 2] >> 3), o);
  }
  return { body: pixels, contentType: 'application/octet-stream', width: info.width, height: info.height };
}

module.exports = { renderCover, parseRenderOptions, InvalidRenderOptions };

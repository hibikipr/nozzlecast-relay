const sharp = require('sharp');

const STARTING_QUALITY = 0.95;
const QUALITY_STEP = 0.05;
const QUALITY_FLOOR = 0.1;

// What a cover's transparent background becomes: the image has to be flattened before it's
// squeezed into the content-state, and a single fixed colour always hides some filament -- black
// swallowed dark models, a mid-grey swallowed grey ones. So it follows the model: a light model
// goes on the dark backdrop, a dark one on the light backdrop. NozzleCast's widget fills the rest
// of its cover tile with the image's own corner colour, so either one blends in. Must match
// CoverImageProcessing.backdropDark/backdropLight in NozzleCastShared, which does the same for
// covers the app downscales itself.
const BACKDROP_DARK = '#1f2329';
const BACKDROP_LIGHT = '#c4c9d1';
// Relative luminance (0-1) of the model's average colour above which it counts as light.
const LIGHT_MODEL_THRESHOLD = 0.5;
// Pixels at least this opaque count as model when averaging its colour.
const MODEL_ALPHA_THRESHOLD = 128;

function modelIsLight({ data, info }) {
  let sum = 0;
  let count = 0;
  for (let offset = 0; offset < data.length; offset += info.channels) {
    if (info.channels === 4 && data[offset + 3] < MODEL_ALPHA_THRESHOLD) continue;
    sum += (0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2]) / 255;
    count += 1;
  }
  return count > 0 && sum / count > LIGHT_MODEL_THRESHOLD;
}

// Downscales a cover render for a Live Activity's content-state, as WebP within `maxBytes`.
//
// ActivityKit's budget for the whole serialized content-state is close to 4KB (a Data field
// costs ~33% more once base64-encoded), and going over doesn't fail gracefully: the system ends
// the Live Activity outright rather than just dropping that one update. So the result has to fit
// exactly, and every byte of it should go on the model:
//
// - Trimmed first. A cover is the model on a mostly transparent canvas (a real 512x512 render's
//   model spanned 184x215), so without the trim most of the pixels described empty canvas.
// - WebP, not JPEG: about 40% of JPEG's size for the same 96px cover, so it fits ~2.7x the
//   pixels. NozzleCast decodes it with ImageIO, which reads WebP on every iOS it supports.
// - Resized to the REAL target pixel dimensions, never enlarged. Don't reintroduce a DPI/density
//   option: the Swift version's original bug was rendering at the device's 2x/3x scale.
//
// Quality starts high (0.95) and steps down by 0.05 while over maxBytes, returning the first --
// i.e. best -- encoding that fits. Still over budget at the 0.1 floor returns null, not a
// smaller image: fails closed, since a blown budget risks the whole activity. The source is
// decoded and resized once, to raw pixels; only the encode repeats per quality step.
async function downscaleCover(buffer, { maxDimension, maxBytes }) {
  const trimmed = await sharp(buffer).ensureAlpha().trim().toBuffer();
  const { data: rgba, info: rgbaInfo } = await sharp(trimmed)
    .resize(maxDimension, maxDimension, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const background = modelIsLight({ data: rgba, info: rgbaInfo }) ? BACKDROP_DARK : BACKDROP_LIGHT;

  const rawRGBA = { raw: { width: rgbaInfo.width, height: rgbaInfo.height, channels: rgbaInfo.channels } };
  const { data: pixels, info } = await sharp(rgba, rawRGBA)
    .flatten({ background })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rawInput = { raw: { width: info.width, height: info.height, channels: info.channels } };

  for (let quality = STARTING_QUALITY; quality >= QUALITY_FLOOR - 1e-9; quality -= QUALITY_STEP) {
    const encoded = await sharp(pixels, rawInput)
      .webp({ quality: Math.round(quality * 100) })
      .toBuffer();
    if (encoded.length <= maxBytes) return encoded;
  }
  return null;
}

module.exports = { downscaleCover, BACKDROP_DARK, BACKDROP_LIGHT };

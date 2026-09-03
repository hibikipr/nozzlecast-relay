const sharp = require('sharp');

const STARTING_QUALITY = 0.5;
const QUALITY_STEP = 0.1;
const QUALITY_FLOOR = 0.1;

// Matches PrintLiveActivityManager.downscaledCoverImage / NotificationService.downscaledThumbnail
// exactly, not an approximation -- ActivityKit's real budget for the whole serialized
// content-state is close to 4KB (a Data field costs ~33% more once base64-encoded on top of its
// raw byte count), and going over doesn't fail gracefully: the system ends the Live Activity
// outright rather than just dropping that one update.
//
// Resize to the REAL target pixel dimensions, not a platform-scaled default: the Swift version's
// whole bug was UIGraphicsImageRenderer silently rendering at the device's 2x/3x screen scale, 9x
// the intended pixel count, which no amount of JPEG quality reduction could claw back under
// budget. There's no equivalent "device scale" concept to fight in Node/sharp, but call this out
// so nobody reintroduces something similar via a DPI/density option.
//
// Starts JPEG quality at 0.5 and steps down by 0.1 while still over maxBytes. If still over
// budget at the 0.1 floor, returns null (not a smaller-than-requested image) -- fails closed the
// same way the Swift guard does, since a blown budget risks the whole activity, not just this
// one field.
async function downscaleImage(buffer, { maxDimension, maxBytes }) {
  const { width, height } = await sharp(buffer).metadata();
  const scale = Math.min(maxDimension / Math.max(width, height), 1);
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));

  for (let quality = STARTING_QUALITY; quality >= QUALITY_FLOOR - 1e-9; quality -= QUALITY_STEP) {
    const encoded = await sharp(buffer)
      .resize(targetWidth, targetHeight)
      .jpeg({ quality: Math.round(quality * 100) })
      .toBuffer();
    if (encoded.length <= maxBytes) return encoded;
  }
  return null;
}

module.exports = { downscaleImage };

import sharp from 'sharp';
import { normalizeRaster } from '../assets/raster';
/** Crop only transparent padding, preserving the drawing; renderer anchors the normalized feet. */
export async function normalizeStaticSprite(bytes: Buffer) {
  const image = sharp(bytes, { limitInputPixels: 4096 * 4096 });
  const meta = await image.metadata();
  if (!meta.hasAlpha || (meta.pages ?? 1) !== 1) throw Error('ALPHA_REQUIRED');
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let left = info.width,
    top = info.height,
    right = -1,
    bottom = -1,
    transparent = false;
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      const alpha = data[(y * info.width + x) * info.channels + info.channels - 1];
      transparent ||= alpha === 0;
      if (alpha > 8) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  if (!transparent || right < left || bottom < top) throw Error('ALPHA_REQUIRED');
  const cropped = await sharp(bytes)
    .extract({ left, top, width: right - left + 1, height: bottom - top + 1 })
    .resize({ width: 256, height: 384, fit: 'inside', withoutEnlargement: true })
    .extend({ top: 3, bottom: 3, left: 3, right: 3, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  return normalizeRaster(cropped, 'image/png', true);
}

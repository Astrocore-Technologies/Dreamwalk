import sharp from 'sharp';
import { portraitCropRect, portraitFrameSchema } from '@dreamwalk/contracts';

/** The part of a hero portrait its owner chose, cut to a bounded square. Falls back to the original. */
export async function framedPortrait(bytes: Buffer, rawFrame: unknown): Promise<Buffer> {
  const frame = portraitFrameSchema.safeParse(rawFrame);
  if (!frame.success) return bytes;
  try {
    const { width, height } = await sharp(bytes).metadata();
    if (!width || !height) return bytes;
    const { sx, sy, side } = portraitCropRect(width, height, frame.data);
    const left = Math.min(width - 1, Math.max(0, Math.floor(sx))),
      top = Math.min(height - 1, Math.max(0, Math.floor(sy)));
    return await sharp(bytes)
      .extract({
        left,
        top,
        width: Math.max(1, Math.min(width - left, Math.round(side))),
        height: Math.max(1, Math.min(height - top, Math.round(side))),
      })
      .resize(512, 512, { fit: 'cover', withoutEnlargement: true })
      .webp({ quality: 90 })
      .toBuffer();
  } catch {
    return bytes;
  }
}

import { z } from 'zod';

/**
 * Which part of a portrait to show in square/round frames. `x`/`y` are the focal point as a
 * fraction of the image (0..1) and `zoom` magnifies around it (1 = the largest square that fits).
 * It is presentation only: the stored image is never changed.
 */
export const portraitFrameSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    zoom: z.number().min(1).max(4),
  })
  .strict();
export type PortraitFrame = z.infer<typeof portraitFrameSchema>;

/** The square (in source pixels) a frame selects. Without a frame: centred, biased to the upper part. */
export function portraitCropRect(width: number, height: number, frame?: PortraitFrame | null) {
  const short = Math.max(1, Math.min(width, height));
  if (!frame) return { sx: (width - short) / 2, sy: (height - short) * 0.25, side: short };
  const side = Math.max(1, short / Math.min(4, Math.max(1, frame.zoom)));
  const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), Math.max(0, max));
  return {
    sx: clamp(frame.x * width - side / 2, width - side),
    sy: clamp(frame.y * height - side / 2, height - side),
    side,
  };
}

/** The frame that reproduces the default crop, used as the editor's starting point. */
export function defaultPortraitFrame(width: number, height: number): PortraitFrame {
  const { sx, sy, side } = portraitCropRect(width, height);
  return {
    x: Math.round(((sx + side / 2) / Math.max(1, width)) * 1000) / 1000,
    y: Math.round(((sy + side / 2) / Math.max(1, height)) * 1000) / 1000,
    zoom: 1,
  };
}

/** Percent geometry for an image inside a square `overflow: hidden` box (no measuring needed). */
export function portraitFrameLayout(width: number, height: number, frame?: PortraitFrame | null) {
  const { sx, sy, side } = portraitCropRect(width, height, frame);
  return {
    width: `${(width / side) * 100}%`,
    height: `${(height / side) * 100}%`,
    left: `${(-sx / side) * 100}%`,
    top: `${(-sy / side) * 100}%`,
  };
}

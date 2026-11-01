import { z } from 'zod';
/** Deliberately restricted to reviewed standard sizes, not all sizes the provider accepts. */
export const reviewedImageSizeSchema = z.enum(['1024x1024', '1536x1024', '1024x1536']);
const dimension = z.number().int().min(1).max(64);
const framingShape = z
  .object({
    version: z.literal(1),
    mapId: z.string().min(1).max(100),
    mapWidth: dimension,
    mapHeight: dimension,
    width: z.number().int(),
    height: z.number().int(),
    size: z.string().regex(/^\d+x\d+$/),
    resolutionMode: z.enum(['exact_map_aspect', 'contain_fallback']),
    fit: z.literal('contain'),
    exactAspect: z.boolean(),
  })
  .strict();
export type ImageFraming = z.infer<typeof framingShape>;
/** Maximize preserved image area; fixed order makes ties deterministic. No viewport input. */
export function deriveMapImageFraming(
  mapId: string,
  mapWidth: number,
  mapHeight: number,
): ImageFraming {
  dimension.parse(mapWidth);
  dimension.parse(mapHeight);
  z.string().min(1).max(100).parse(mapId);
  const sizes = [
    [1024, 1024],
    [1536, 1024],
    [1024, 1536],
  ] as const;
  let best: readonly [number, number] = sizes[0],
    bestNumerator = 0,
    bestDenominator = 1;
  for (const [width, height] of sizes) {
    const a = mapWidth * height,
      b = mapHeight * width;
    const numerator = Math.min(a, b),
      denominator = Math.max(a, b);
    if (numerator * bestDenominator > bestNumerator * denominator) {
      best = [width, height];
      bestNumerator = numerator;
      bestDenominator = denominator;
    }
  }
  // Sunburst documented size lattice: 16px, 1:3..3:1, 655360..8294400px, edge <=3840.
  // Pick the exact-ratio candidate nearest 1MP; never estimate its monetary cost here.
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const divisor = gcd(mapWidth, mapHeight);
  const unitW = (16 * mapWidth) / divisor,
    unitH = (16 * mapHeight) / divisor;
  let exact: readonly [number, number] | undefined;
  let distance = Infinity;
  if (Math.max(mapWidth, mapHeight) <= 3 * Math.min(mapWidth, mapHeight)) {
    for (let k = 1; k * Math.max(unitW, unitH) <= 3840; k++) {
      const pixels = unitW * unitH * k * k;
      if (pixels < 655360 || pixels > 8294400) continue;
      const delta = Math.abs(pixels - 1048576);
      if (delta < distance) {
        exact = [unitW * k, unitH * k];
        distance = delta;
      }
    }
  }
  const [width, height] = exact ?? best;
  return {
    version: 1,
    mapId,
    mapWidth,
    mapHeight,
    width,
    height,
    size: `${width}x${height}` as ImageFraming['size'],
    resolutionMode: exact ? 'exact_map_aspect' : 'contain_fallback',
    fit: 'contain',
    exactAspect: mapWidth * height === mapHeight * width,
  };
}
export const imageFramingSchema = framingShape.refine(
  (v) =>
    JSON.stringify(v) ===
    JSON.stringify({ ...v, ...deriveMapImageFraming(v.mapId, v.mapWidth, v.mapHeight) }),
  { message: 'MAP_IMAGE_FRAMING_MISMATCH' },
);
/** A new aspect never silently changes an approved profile or its reserve assumptions. */
export function imageFramingMatchesProfile(
  framing: ImageFraming | undefined,
  approvedSize: string,
  policy?: {
    mode: string;
    minPixels: number;
    maxPixels: number;
    maxEdge: number;
    maxAspectRatio: number;
  },
) {
  if (!framing) return true;
  const f = imageFramingSchema.parse(framing);
  if (policy?.mode === 'map_aspect_reviewed_range') {
    return (
      f.width * f.height >= policy.minPixels &&
      f.width * f.height <= policy.maxPixels &&
      Math.max(f.width, f.height) <= policy.maxEdge &&
      Math.max(f.width, f.height) <= policy.maxAspectRatio * Math.min(f.width, f.height)
    );
  }
  return f.size === approvedSize;
}
/** Versioned evidence must survive quote round-trip unchanged; old unversioned rows remain readable. */
export function imageFramingEvidenceMatches(
  expected: { framingVersion?: 1; imageFraming?: ImageFraming | null },
  actual: { framingVersion?: 1; imageFraming?: ImageFraming | null },
): boolean {
  if (expected.framingVersion !== actual.framingVersion) return false;
  if (!expected.imageFraming || !actual.imageFraming)
    return !expected.imageFraming && !actual.imageFraming;
  const a = imageFramingSchema.safeParse(expected.imageFraming),
    b = imageFramingSchema.safeParse(actual.imageFraming);
  return a.success && b.success && JSON.stringify(a.data) === JSON.stringify(b.data);
}

import { z } from 'zod';
const edge = z.number().int().min(8).max(24);
const aspect = z.number().int().min(1).max(24);
/** Optional author constraints, not a movement grid or a viewport size. Omission is legacy automatic choice. */
export const mapIntentSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('dimensions'), width: edge, height: edge }).strict(),
    z.object({ kind: z.literal('aspect'), width: aspect, height: aspect }).strict(),
  ])
  .refine(
    (v) =>
      v.kind === 'dimensions' ||
      Array.from({ length: 17 }, (_, i) => i + 8).some((w) => {
        const h = (w * v.height) / v.width;
        return Number.isInteger(h) && h >= 8 && h <= 24;
      }),
    { message: 'MAP_INTENT_UNSUPPORTED_ASPECT' },
  );
export type MapIntent = z.infer<typeof mapIntentSchema>;
export function mapMatchesIntent(
  intent: MapIntent | undefined,
  width: number,
  height: number,
): boolean {
  if (!intent) return true;
  const parsed = mapIntentSchema.parse(intent);
  return parsed.kind === 'dimensions'
    ? width === parsed.width && height === parsed.height
    : width * parsed.height === height * parsed.width;
}

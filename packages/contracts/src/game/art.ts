import { z } from 'zod';

/** A pinned, verified raster revision. Never contains storage paths or author metadata. */
export const frozenArtBindingSchema = z
  .object({
    slot: z
      .string()
      .min(1)
      .max(160)
      .refine((slot) => {
        const parts = slot.split(':');
        const id = parts[1] ?? '';
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || id in Object.prototype) return false;
        return (
          (parts.length === 3 &&
            ((parts[0] === 'map' && parts[2] === 'background') ||
              (parts[0] === 'entity' && ['sprite', 'portrait'].includes(parts[2])))) ||
          (parts.length === 4 &&
            parts[0] === 'entity' &&
            parts[2] === 'object' &&
            ['default', 'open', 'closed'].includes(parts[3]))
        );
      }),
    revisionId: z.string().uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mime: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    width: z.number().int().min(1).max(8192),
    height: z.number().int().min(1).max(8192),
  })
  .strict();
export const frozenArtBindingsSchema = z
  .array(frozenArtBindingSchema)
  .max(128)
  .refine((bindings) => new Set(bindings.map((b) => b.slot)).size === bindings.length);
export type FrozenArtBinding = z.infer<typeof frozenArtBindingSchema>;

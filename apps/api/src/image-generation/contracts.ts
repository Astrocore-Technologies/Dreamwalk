import { z } from 'zod';
export const generationRequestSchema = z
  .object({
    adventureId: z.uuid(),
    campaignContext: z
      .object({
        campaignId: z.uuid(),
        expectedCanonRevision: z.number().int().min(0),
        groundingHash: z.string().regex(/^[a-f0-9]{64}$/),
        kind: z.enum(['background', 'portrait']),
        entityId: z
          .string()
          .regex(/^[\w-]+$/)
          .max(100)
          .optional(),
      })
      .strict()
      .optional(),
    prompt: z.string().trim().min(1).max(2000),
    title: z.string().trim().min(1).max(120),
    kind: z.enum(['background', 'sprite', 'portrait', 'object']),
    camera: z.enum(['top-down', 'portrait', 'unrestricted']),
    tags: z.array(z.string().trim().min(1).max(48)).max(24),
    background: z.enum(['opaque', 'transparent']),
    referenceRevisionIds: z.array(z.uuid()).max(2).default([]),
    rights: z
      .object({
        basis: z.literal('generated'),
        licenseLabel: z.string().trim().min(1).max(120),
        attribution: z.string().max(240),
        allowAuthorReuse: z.boolean(),
        attested: z.literal(true),
      })
      .strict(),
    mode: z.enum(['mock', 'external']).default('mock'),
    declineReuse: z.boolean().optional(),
  })
  .strict()
  .refine((v) => new Set(v.referenceRevisionIds).size === v.referenceRevisionIds.length)
  .refine((v) => !['sprite', 'object'].includes(v.kind) || v.background === 'transparent', {
    message: 'ALPHA_REQUIRED',
  });
export type GenerationRequest = z.infer<typeof generationRequestSchema>;
export interface ImagePolicy {
  version: string;
  scopeId: string;
  externalEnabled: boolean;
  verifiedUpperMicros: number | null;
  mockUpperMicros: number;
  approved: boolean;
  totalCapMicros: number;
  imageCapMicros: number;
  textCapMicros: number;
  quoteTtlMs: number;
  dispatchTimeoutMs: number;
}
export const defaultImagePolicy: ImagePolicy = Object.freeze({
  version: 'image-preparation-v1',
  scopeId: 'approved-test-20261030',
  externalEnabled: false,
  verifiedUpperMicros: null,
  mockUpperMicros: 0,
  approved: false,
  totalCapMicros: 2000000,
  imageCapMicros: 1000000,
  textCapMicros: 1000000,
  quoteTtlMs: 300000,
  dispatchTimeoutMs: 60000,
});

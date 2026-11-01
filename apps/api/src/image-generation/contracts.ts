import { z } from 'zod';
export const authoringContextSchema = z
  .object({
    projectId: z.uuid(),
    expectedProjectRevision: z.number().int().min(0),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    stage: z.enum(['concept', 'parts']),
    role: z.string().regex(/^[a-z0-9_-]{1,80}$/),
  })
  .strict();
export type AuthoringContext = z.infer<typeof authoringContextSchema>;
export const generationRequestSchema = z
  .object({
    adventureId: z.uuid().optional(),
    liveTestSessionId: z.uuid().optional(),
    studioLocationContext: z
      .object({
        locationId: z.string().trim().min(1).max(80),
        expectedEditRevision: z.number().int().positive(),
        sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
    authoringContext: authoringContextSchema.optional(),
    privateReferenceAssetIds: z.array(z.uuid()).max(1).default([]),
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
  .refine((v) => !v.studioLocationContext || !!v.adventureId)
  .refine(
    (v) =>
      [v.authoringContext, v.campaignContext, v.studioLocationContext].filter(Boolean).length <= 1,
  )
  .refine((v) => !!v.adventureId || !!v.authoringContext, {
    message: 'GENERATION_CONTEXT_REQUIRED',
  })
  .refine((v) => !(v.authoringContext && v.campaignContext), {
    message: 'INVALID_GENERATION_CONTEXT',
  })
  .refine((v) => !v.privateReferenceAssetIds.length || !!v.authoringContext, {
    message: 'PRIVATE_REFERENCE_CONTEXT_REQUIRED',
  })
  .refine((v) => v.referenceRevisionIds.length + v.privateReferenceAssetIds.length <= 2)
  .refine(
    (v) =>
      new Set([...v.referenceRevisionIds, ...v.privateReferenceAssetIds]).size ===
      v.referenceRevisionIds.length + v.privateReferenceAssetIds.length,
  )
  .refine((v) => new Set(v.referenceRevisionIds).size === v.referenceRevisionIds.length)
  .refine((v) => !['sprite', 'object'].includes(v.kind) || v.background === 'transparent', {
    message: 'ALPHA_REQUIRED',
  });
export type GenerationRequest = z.infer<typeof generationRequestSchema>;
export interface ImagePolicy {
  version: string;
  scopeId: string;
  externalEnabled: boolean;
  externalExpiresAt?: string;
  verifiedUpperMicros: number | null;
  costBasis?: 'verified_bound' | 'approved_estimate';
  estimatedTotalMicros?: number;
  operationalReserveMicros?: number;
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

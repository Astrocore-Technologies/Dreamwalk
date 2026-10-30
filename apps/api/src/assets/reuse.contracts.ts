import { z } from 'zod';
const identifier = z.uuid();
const tag = z
  .string()
  .trim()
  .min(1)
  .max(48)
  .transform((v) => v.toLocaleLowerCase());
export const assetMetadataSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    kind: z.enum(['background', 'portrait', 'sprite', 'object', 'effect', 'ui']),
    style: z.literal('drawn2D'),
    camera: z.enum(['top-down', 'side', 'isometric', 'portrait', 'unrestricted']),
    tags: z
      .array(tag)
      .max(24)
      .transform((v) => [...new Set(v)].sort()),
    variant: z.string().trim().min(1).max(80),
    provenance: z
      .object({
        source: z.enum(['upload', 'licensed-import', 'generated']),
        provider: z.string().trim().max(80).optional(),
        reference: z.string().trim().max(300).optional(),
      })
      .strict(),
    rights: z
      .object({
        basis: z.enum(['owned', 'licensed', 'generated']),
        licenseLabel: z.string().trim().min(1).max(120),
        attribution: z.string().trim().max(240),
        allowAuthorReuse: z.boolean(),
        attested: z.literal(true),
      })
      .strict(),
  })
  .strict();
export const registerRevisionSchema = z
  .object({
    operationId: identifier,
    uploadId: identifier,
    familyId: identifier.optional(),
    expectedFamilyRevision: z.number().int().min(1).optional(),
    metadata: assetMetadataSchema,
  })
  .strict()
  .refine((v) => Boolean(v.familyId) === Boolean(v.expectedFamilyRevision));
export const assetSpecSchema = z
  .object({
    kind: z.enum(['background', 'portrait', 'sprite', 'object', 'effect', 'ui']),
    style: z.literal('drawn2D'),
    camera: z.enum(['top-down', 'side', 'isometric', 'portrait', 'unrestricted']),
    tags: z
      .array(tag)
      .max(24)
      .transform((v) => [...new Set(v)].sort()),
    minWidth: z.number().int().min(1).max(4096),
    minHeight: z.number().int().min(1).max(4096),
    variant: z.string().trim().min(1).max(80).optional(),
  })
  .strict();
export const grantReuseSchema = z
  .object({
    operationId: identifier,
    granteeUserId: identifier.optional(),
    granteeHandle: z
      .string()
      .trim()
      .min(3)
      .max(40)
      .regex(/^[a-zA-Z0-9_-]+$/)
      .optional(),
    consent: z.literal(true),
    retainExistingPins: z.literal(true),
  })
  .strict()
  .refine((v) => Boolean(v.granteeUserId) !== Boolean(v.granteeHandle));
export const bindingSchema = z
  .object({ slot: z.string().regex(/^[a-zA-Z0-9_:/.-]{1,160}$/), revisionId: identifier })
  .strict();
export const draftBindingsSchema = z
  .object({
    operationId: identifier,
    expectedRevision: z.number().int().min(0),
    bindings: z.array(bindingSchema).max(128),
  })
  .strict()
  .refine((v) => new Set(v.bindings.map((x) => x.slot)).size === v.bindings.length);
export type AssetMetadata = z.infer<typeof assetMetadataSchema>;
export type AssetSpec = z.infer<typeof assetSpecSchema>;
export type AssetBinding = z.infer<typeof bindingSchema>;

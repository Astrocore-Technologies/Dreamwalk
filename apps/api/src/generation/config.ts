/** Pure server-operator configuration. No files, credentials, network or financial scope input. */
import { createHash } from 'node:crypto';
import { z } from 'zod';

const positiveMicros = z.number().int().positive().max(1_000_000_000_000);
const model = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/);
const pricingSchema = z
  .object({
    source: z
      .url()
      .max(500)
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === 'https:' &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          !url.port &&
          ['openai.com', 'developers.openai.com', 'platform.openai.com'].includes(url.hostname)
        );
      }),
    reviewedAt: z.iso.datetime(),
    validUntil: z.iso.datetime(),
  })
  .strict();
const textSchema = z
  .object({
    model,
    contextTokens: z.number().int().positive().max(1_050_000),
    maxOutputTokens: z.number().int().min(16).max(32_000),
    maxInputBytes: z.number().int().min(1024).max(64_000),
    inputMicrosPerMillion: positiveMicros,
    outputMicrosPerMillion: positiveMicros,
    pricing: pricingSchema,
  })
  .strict()
  // Conservative UTF-8 byte bound plus protocol allowance, not a guessed tokenizer ratio.
  .refine((value) => value.maxInputBytes + 4096 + value.maxOutputTokens <= value.contextTokens);
const imageSchema = z
  .object({
    model,
    size: z.enum(['1024x1024', '1024x1536', '1536x1024']),
    quality: z.enum(['low', 'medium', 'high']),
    outputs: z.literal(1),
    format: z.literal('png'),
    maxPromptUtf8Bytes: z.number().int().positive().max(8000),
    maxReferenceImages: z.number().int().min(0).max(2),
    inputTextMicrosPerMillion: positiveMicros,
    inputImageMicrosPerMillion: positiveMicros,
    outputImageMicrosPerMillion: positiveMicros,
    estimatedTotalMicros: positiveMicros,
    reserveMicros: positiveMicros,
    estimateRiskAccepted: z.literal(true),
    pricing: pricingSchema,
  })
  .strict()
  .refine((value) => value.reserveMicros >= value.estimatedTotalMicros);
const profileSchema = z
  .object({
    totalCapMicros: positiveMicros,
    textCapMicros: positiveMicros,
    imageCapMicros: positiveMicros,
    text: textSchema,
    image: imageSchema,
  })
  .strict();

export type OwnerPricingEvidence = Readonly<z.infer<typeof pricingSchema>>;
export type OwnerTextProfile = Readonly<z.infer<typeof textSchema> & { upperMicros: number }>;
export type OwnerImageProfile = Readonly<
  z.infer<typeof imageSchema> & {
    maxReferenceBytes: number;
    maxReferencePixels: number;
    costBasis: 'approved_estimate';
    providerEnforcesQuotedCap: false;
  }
>;
export interface OwnerGenerationConfig {
  readonly mode: 'owner';
  readonly ownerHandle: string;
  readonly totalCapMicros: number;
  readonly textCapMicros: number;
  readonly imageCapMicros: number;
  readonly text: OwnerTextProfile;
  readonly image: OwnerImageProfile;
  /** Quote/profile identity only. Never use this value as a new financial scope. */
  readonly configFingerprint: string;
}
export class OwnerGenerationConfigurationError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'OwnerGenerationConfigurationError';
  }
}
function invalid(code: string): never {
  // Never expose Zod issues, operator input, model strings or credentials in errors.
  throw new OwnerGenerationConfigurationError(code);
}
export function ownerPricingIsCurrent(pricing: OwnerPricingEvidence, now = Date.now()) {
  const reviewed = Date.parse(pricing.reviewedAt),
    until = Date.parse(pricing.validUntil);
  return Number.isFinite(now) && reviewed <= now && until > now && until > reviewed;
}

/** Explicit invalid owner configuration is an error, never an implicit mock/manual fallback. */
export function readOwnerGenerationConfig(
  env: Record<string, string | undefined>,
  now = Date.now(),
): OwnerGenerationConfig | { mode: 'disabled' } {
  if (env.GENERATION_MODE === undefined || env.GENERATION_MODE === 'disabled')
    return { mode: 'disabled' };
  if (env.GENERATION_MODE !== 'owner') invalid('OWNER_GENERATION_MODE_INVALID');
  const ownerHandle = env.GENERATION_OWNER_HANDLE;
  if (!ownerHandle || !/^[a-z0-9_]{3,30}$/.test(ownerHandle))
    invalid('OWNER_GENERATION_HANDLE_INVALID');
  const raw = env.GENERATION_OWNER_CONFIG_JSON;
  if (!raw || Buffer.byteLength(raw, 'utf8') > 16_000) invalid('OWNER_GENERATION_CONFIG_INVALID');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    invalid('OWNER_GENERATION_CONFIG_INVALID');
  }
  const parsed = profileSchema.safeParse(value);
  if (!parsed.success) invalid('OWNER_GENERATION_CONFIG_INVALID');
  const profile = parsed.data;
  if (
    !ownerPricingIsCurrent(profile.text.pricing, now) ||
    !ownerPricingIsCurrent(profile.image.pricing, now)
  )
    invalid('OWNER_GENERATION_CURRENT_PRICING_REQUIRED');
  const upper =
    (BigInt(profile.text.contextTokens) * BigInt(profile.text.inputMicrosPerMillion) +
      BigInt(profile.text.maxOutputTokens) * BigInt(profile.text.outputMicrosPerMillion) +
      999_999n) /
    1_000_000n;
  if (
    upper > BigInt(profile.textCapMicros) ||
    profile.textCapMicros > profile.totalCapMicros ||
    profile.imageCapMicros > profile.totalCapMicros ||
    profile.image.reserveMicros > profile.imageCapMicros
  )
    invalid('OWNER_GENERATION_BUDGET_INVALID');
  const text: OwnerTextProfile = Object.freeze({
    ...profile.text,
    pricing: Object.freeze(profile.text.pricing),
    upperMicros: Number(upper),
  });
  const image: OwnerImageProfile = Object.freeze({
    ...profile.image,
    pricing: Object.freeze(profile.image.pricing),
    maxReferenceBytes: 5 * 1024 * 1024,
    maxReferencePixels: 4096 * 4096,
    costBasis: 'approved_estimate',
    providerEnforcesQuotedCap: false,
  });
  const configured = {
    mode: 'owner' as const,
    ownerHandle,
    totalCapMicros: profile.totalCapMicros,
    textCapMicros: profile.textCapMicros,
    imageCapMicros: profile.imageCapMicros,
    text,
    image,
  };
  // Zod fixes property order; credential rotation does not change quote identity.
  return Object.freeze({
    ...configured,
    configFingerprint: createHash('sha256').update(JSON.stringify(configured)).digest('hex'),
  });
}

/** Pure server-operator configuration. No files, credentials, network or financial scope input. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { estimateTextRequest, estimateImageRequest, type ImageEstimateProfile } from './estimates';
import { imageFramingMatchesProfile, type ImageFraming } from '@dreamwalk/contracts';
import { TEXT_CONTEXT_TRANSPORT_BYTES } from '../ai/text-context';

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
const textEstimationSchema = z
  .object({
    kind: z.literal('operator_heuristic'),
    textTokensPerKiBUtf8: z.number().int().min(1).max(1048576),
    textProtocolTokens: z.number().int().min(0).max(1048576),
    marginBps: z.number().int().min(0).max(100000),
    fixedMarginMicros: z.number().int().min(0).max(1000000000000),
  })
  .strict();
const imageEstimationSchema = textEstimationSchema
  .extend({
    outputImageTokens: z.number().int().min(1).max(1048576),
    referenceImageTokensPerImage: z.number().int().min(0).max(1048576),
    referenceAllowanceMicros: z.number().int().min(0).max(1000000000000),
  })
  .strict();
const textSchema = z
  .object({
    model,
    contextTokens: z.number().int().positive().max(1_050_000),
    contextBudgetTokens: z.number().int().min(1024).optional(),
    counting: z
      .object({
        kind: z.literal('owner_reviewed_fixed'),
        microsPerRequest: z.number().int().min(0).max(1_000_000_000_000),
        pricing: pricingSchema,
      })
      .strict()
      .optional(),
    maxOutputTokens: z.number().int().min(16).max(32_000),
    storyPlanMaxOutputTokens: z.number().int().min(16).max(32_000).optional(),
    storyVision: z
      .object({
        model,
        inputTokensPerImage: z.number().int().min(1).max(1048576),
        maxImages: z.number().int().min(1).max(4),
        detail: z.literal('high'),
        billing: z.literal('text_input_rate'),
        maxPricedInputTokens: z.number().int().min(1).max(1050000),
        pricing: pricingSchema,
      })
      .strict()
      .optional(),
    runtimeVision: z
      .union([
        z.literal(false),
        z
          .object({
            model,
            inputTokensPerImage: z.number().int().min(1).max(1048576),
            maxImages: z.literal(1),
            detail: z.literal('high'),
            billing: z.literal('text_input_rate'),
            maxPricedInputTokens: z.number().int().min(1).max(1050000),
            pricing: pricingSchema,
          })
          .strict(),
        z
          .object({
            model,
            counting: z.literal('operational_exact'),
            maxImages: z.literal(1),
            detail: z.literal('high'),
            billing: z.literal('text_input_rate'),
            maxPricedInputTokens: z.number().int().min(1).max(1050000),
            pricing: pricingSchema,
          })
          .strict(),
      ])
      .optional(),
    maxInputBytes: z.number().int().min(1024).max(TEXT_CONTEXT_TRANSPORT_BYTES).optional(),
    inputMicrosPerMillion: positiveMicros,
    outputMicrosPerMillion: positiveMicros,
    cachePricing: z
      .object({
        cachedInputMicrosPerMillion: positiveMicros,
        cacheWrite30mMicrosPerMillion: positiveMicros,
        cacheWrite12hMicrosPerMillion: positiveMicros,
      })
      .strict()
      .optional(),
    estimation: textEstimationSchema.optional(),
    pricing: pricingSchema,
  })
  .strict()
  .refine(
    (v) =>
      !v.storyVision ||
      (!!v.estimation && v.contextBudgetTokens !== undefined && v.storyVision.model === v.model),
  )
  .refine(
    (v) =>
      !v.runtimeVision ||
      (!!v.estimation &&
        v.contextBudgetTokens !== undefined &&
        v.runtimeVision.model === v.model &&
        v.runtimeVision.maxImages === 1),
  )
  // Purpose overrides are explicit operator policy and require per-request quoting.
  .refine((value) => value.storyPlanMaxOutputTokens === undefined || !!value.estimation)
  // Conservative UTF-8 byte bound plus protocol allowance, not a guessed tokenizer ratio.
  .refine((value) =>
    value.contextBudgetTokens !== undefined
      ? !!value.estimation &&
        Math.max(value.maxOutputTokens, value.storyPlanMaxOutputTokens ?? 0) <
          Math.min(value.contextBudgetTokens, value.contextTokens)
      : !value.counting &&
        value.maxInputBytes !== undefined &&
        value.maxInputBytes <= 64000 &&
        value.maxInputBytes +
          4096 +
          Math.max(value.maxOutputTokens, value.storyPlanMaxOutputTokens ?? 0) <=
          value.contextTokens,
  )
  .transform((value) => ({
    ...value,
    maxInputBytes:
      value.contextBudgetTokens !== undefined ? TEXT_CONTEXT_TRANSPORT_BYTES : value.maxInputBytes!,
  }));
const customFramingPolicySchema = z
  .object({
    version: z.literal(1),
    mode: z.literal('map_aspect_reviewed_range'),
    assumptionKind: z.literal('operator_range_ceiling_estimate'),
    maxAspectRatio: z.number().min(1).max(3),
    quality: z.enum(['low', 'medium', 'high']),
    minPixels: z.number().int().min(655360).max(8294400),
    maxPixels: z.number().int().min(655360).max(8294400),
    maxEdge: z.number().int().min(16).max(3840),
    reviewedOutputImageTokens: z.number().int().min(1).max(1048576),
    pricing: pricingSchema,
  })
  .strict();
const imageSchema = z
  .object({
    model,
    size: z.string().regex(/^\d+x\d+$/),
    framingPolicy: customFramingPolicySchema.optional(),
    quality: z.enum(['low', 'medium', 'high']),
    outputs: z.literal(1),
    format: z.literal('png'),
    maxPromptUtf8Bytes: z.number().int().positive().max(8000),
    maxReferenceImages: z.number().int().min(0).max(2),
    inputTextMicrosPerMillion: positiveMicros,
    inputImageMicrosPerMillion: positiveMicros,
    outputImageMicrosPerMillion: positiveMicros,
    estimatedTotalMicros: positiveMicros.optional(),
    reserveMicros: positiveMicros.optional(),
    estimation: imageEstimationSchema.optional(),
    estimateRiskAccepted: z.literal(true),
    pricing: pricingSchema,
  })
  .strict()
  .refine((value) =>
    value.estimation
      ? value.estimatedTotalMicros === undefined &&
        value.reserveMicros === undefined &&
        (!value.maxReferenceImages ||
          value.estimation.referenceImageTokensPerImage > 0 ||
          value.estimation.referenceAllowanceMicros > 0)
      : value.estimatedTotalMicros !== undefined &&
        value.reserveMicros !== undefined &&
        value.reserveMicros >= value.estimatedTotalMicros,
  );
// Omitted policy preserves the old exact profile serialization and allowed sizes.
const reviewedImageSchema = imageSchema.refine(
  (value) => {
    const policy = value.framingPolicy;
    if (!policy) return ['1024x1024', '1024x1536', '1536x1024'].includes(value.size);
    const [w, h] = value.size.split('x').map(Number);
    return (
      value.model === 'gpt-image-2.5-sunburst-2026-09-08' &&
      w > 0 &&
      h > 0 &&
      w % 16 === 0 &&
      h % 16 === 0 &&
      Math.max(w, h) <= policy.maxEdge &&
      Math.max(w, h) <= policy.maxAspectRatio * Math.min(w, h) &&
      value.quality === policy.quality &&
      w * h >= policy.minPixels &&
      w * h <= policy.maxPixels &&
      policy.minPixels <= policy.maxPixels &&
      !!value.estimation &&
      value.estimation.outputImageTokens === policy.reviewedOutputImageTokens &&
      JSON.stringify(policy.pricing) === JSON.stringify(value.pricing)
    );
  },
  { message: 'CUSTOM_IMAGE_SIZE_REQUIRES_REVIEWED_POLICY_AND_COST_EVIDENCE' },
);
const profileSchema = z
  .object({
    totalCapMicros: positiveMicros,
    textCapMicros: positiveMicros,
    imageCapMicros: positiveMicros,
    text: textSchema,
    image: reviewedImageSchema,
  })
  .strict();

export type OwnerPricingEvidence = Readonly<z.infer<typeof pricingSchema>>;
export type OwnerTextProfile = Readonly<z.infer<typeof textSchema> & { upperMicros: number }>;
export type OwnerImageProfile = Readonly<
  Omit<z.infer<typeof imageSchema>, 'estimatedTotalMicros' | 'reserveMicros'> & {
    estimatedTotalMicros: number;
    reserveMicros: number;
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
export type ReleaseGenerationConfig = Omit<
  OwnerGenerationConfig,
  'mode' | 'ownerHandle' | 'totalCapMicros' | 'textCapMicros' | 'imageCapMicros'
> & {
  readonly mode: 'release';
  readonly allowance?: 'unlimited';
  readonly totalCapMicros: number | null;
  readonly textCapMicros: number | null;
  readonly imageCapMicros: number | null;
  readonly aggregateCapMicros: number | null;
};
export type ConfiguredGenerationConfig = OwnerGenerationConfig | ReleaseGenerationConfig;

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
  const profile = validatedProfile(value, now, false);
  const configured = {
    mode: 'owner' as const,
    ownerHandle,
    ...profile,
    totalCapMicros: profile.totalCapMicros!,
    textCapMicros: profile.textCapMicros!,
    imageCapMicros: profile.imageCapMicros!,
  };
  return Object.freeze({
    ...configured,
    configFingerprint: createHash('sha256').update(JSON.stringify(configured)).digest('hex'),
  });
}
function validatedProfile(value: unknown, now: number, unlimited: boolean) {
  const parsed = unlimited
    ? z
        .object({ text: textSchema, image: reviewedImageSchema })
        .strict()
        .transform((v) => ({
          ...v,
          totalCapMicros: null,
          textCapMicros: null,
          imageCapMicros: null,
        }))
        .safeParse(value)
    : profileSchema.safeParse(value);
  if (!parsed.success) invalid('OWNER_GENERATION_CONFIG_INVALID');
  const profile = parsed.data;
  if (
    !ownerPricingIsCurrent(profile.text.pricing, now) ||
    !ownerPricingIsCurrent(profile.image.pricing, now)
  )
    invalid('OWNER_GENERATION_CURRENT_PRICING_REQUIRED');
  let minimumTextReserve: number,
    upper: number,
    maxImageReserve: number,
    imageBaseline: { estimatedTotalMicros: number; reserveMicros: number };
  try {
    const budgetProfile = {
      ...profile.text,
      maxOutputTokens: Math.max(
        profile.text.maxOutputTokens,
        profile.text.storyPlanMaxOutputTokens ?? 0,
      ),
    };
    upper = estimateTextRequest(
      'a'.repeat(
        profile.text.contextBudgetTokens !== undefined
          ? Math.max(
              0,
              Math.min(profile.text.contextBudgetTokens, profile.text.contextTokens) -
                budgetProfile.maxOutputTokens -
                Math.max(4096, profile.text.estimation?.textProtocolTokens ?? 0),
            )
          : profile.text.maxInputBytes,
      ),
      budgetProfile,
      'configuration-limit-validation',
    ).reserveMicros;
    minimumTextReserve = estimateTextRequest(
      '',
      budgetProfile,
      'configuration-minimum',
    ).reserveMicros;
    const imageProfile = profile.image as ImageEstimateProfile;
    maxImageReserve = estimateImageRequest(
      'a'.repeat(profile.image.maxPromptUtf8Bytes),
      profile.image.maxReferenceImages,
      imageProfile,
      'configuration-limit-validation',
    ).reserveMicros;
    imageBaseline = estimateImageRequest('', 0, imageProfile, 'configuration-baseline');
  } catch {
    invalid('OWNER_GENERATION_ESTIMATION_INVALID');
  }
  if (
    profile.totalCapMicros !== null &&
    profile.textCapMicros !== null &&
    profile.imageCapMicros !== null &&
    ((profile.text.estimation ? minimumTextReserve : upper) > profile.textCapMicros ||
      profile.textCapMicros > profile.totalCapMicros ||
      profile.imageCapMicros > profile.totalCapMicros ||
      (profile.image.estimation ? imageBaseline.reserveMicros : maxImageReserve) >
        profile.imageCapMicros)
  )
    invalid('OWNER_GENERATION_BUDGET_INVALID');
  const text: OwnerTextProfile = Object.freeze({
    ...profile.text,
    pricing: Object.freeze(profile.text.pricing),
    ...(profile.text.cachePricing
      ? { cachePricing: Object.freeze(profile.text.cachePricing) }
      : {}),
    ...(profile.text.estimation ? { estimation: Object.freeze(profile.text.estimation) } : {}),
    upperMicros: upper,
  });
  const image: OwnerImageProfile = Object.freeze({
    ...profile.image,
    ...(profile.image.framingPolicy
      ? {
          framingPolicy: Object.freeze({
            ...profile.image.framingPolicy,
            pricing: Object.freeze(profile.image.framingPolicy.pricing),
          }),
        }
      : {}),
    estimatedTotalMicros: profile.image.estimatedTotalMicros ?? imageBaseline.estimatedTotalMicros,
    reserveMicros: profile.image.reserveMicros ?? imageBaseline.reserveMicros,
    ...(profile.image.estimation ? { estimation: Object.freeze(profile.image.estimation) } : {}),
    pricing: Object.freeze(profile.image.pricing),
    maxReferenceBytes: 5 * 1024 * 1024,
    maxReferencePixels: 4096 * 4096,
    costBasis: 'approved_estimate',
    providerEnforcesQuotedCap: false,
  });
  return {
    totalCapMicros: profile.totalCapMicros,
    textCapMicros: profile.textCapMicros,
    imageCapMicros: profile.imageCapMicros,
    text,
    image,
  };
}

/** Resolve only inside an explicitly reviewed range; the SAME conservative token assumption
 * is used for every size, not a guessed per-pixel formula or provider-enforced guarantee. */
export function resolveOwnerImageProfile(
  profile: OwnerImageProfile,
  framing?: ImageFraming,
): OwnerImageProfile {
  if (!imageFramingMatchesProfile(framing, profile.size, profile.framingPolicy))
    throw new Error('IMAGE_SIZE_POLICY_REVIEW_REQUIRED');
  return framing && profile.framingPolicy?.mode === 'map_aspect_reviewed_range'
    ? { ...profile, size: framing.size }
    : profile;
}

/** Release deliberately has no account handle or expiring test grant. Reuses the strict
 * pricing validator; financial scope identity is never derived from this profile. */
export function readGenerationConfig(
  env: Record<string, string | undefined>,
  now = Date.now(),
): ConfiguredGenerationConfig | { mode: 'disabled' } {
  if (env.GENERATION_MODE !== 'release') return readOwnerGenerationConfig(env, now);
  const raw = env.GENERATION_CONFIG_JSON;
  if (!raw || Buffer.byteLength(raw, 'utf8') > 16000) invalid('GENERATION_CONFIG_INVALID');
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw);
  } catch {
    invalid('GENERATION_CONFIG_INVALID');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid('GENERATION_CONFIG_INVALID');
  // The owner enabled gameplay vision. Only this documented image-capable model
  // gets the allowance-free default; other models need an explicit reviewed policy.
  // Existing tariffs/dates remain authoritative, and an explicit false opts out.
  const text = value.text as Record<string, unknown> | undefined;
  if (
    text &&
    text.model === 'gpt-6-luna' &&
    text.contextBudgetTokens !== undefined &&
    text.estimation &&
    !('runtimeVision' in text)
  ) {
    value = {
      ...value,
      text: {
        ...text,
        runtimeVision: {
          model: 'gpt-6-luna',
          counting: 'operational_exact',
          maxImages: 1,
          detail: 'high',
          billing: 'text_input_rate',
          maxPricedInputTokens: 272000,
          pricing: text.pricing,
        },
      },
    };
  }
  if (value.allowance === 'unlimited') {
    const { allowance: _allowance, ...rest } = value;
    void _allowance;
    const profile = validatedProfile(rest, now, true);
    const configured = {
      ...profile,
      mode: 'release' as const,
      allowance: 'unlimited' as const,
      aggregateCapMicros: null,
    };
    return Object.freeze({
      ...configured,
      configFingerprint: createHash('sha256').update(JSON.stringify(configured)).digest('hex'),
    });
  }
  const { aggregateCapMicros, ...profile } = value;
  const aggregate = positiveMicros.safeParse(aggregateCapMicros);
  if (!aggregate.success) invalid('GENERATION_AGGREGATE_CAP_REQUIRED');
  const legacy = readOwnerGenerationConfig(
    {
      GENERATION_MODE: 'owner',
      GENERATION_OWNER_HANDLE: 'release_profile',
      GENERATION_OWNER_CONFIG_JSON: JSON.stringify(profile),
    },
    now,
  );
  if (legacy.mode !== 'owner') invalid('GENERATION_CONFIG_INVALID');
  if (aggregate.data < legacy.totalCapMicros) invalid('GENERATION_AGGREGATE_CAP_INVALID');
  const { ownerHandle: _handle, configFingerprint: _fingerprint, ...validated } = legacy;
  void _handle;
  void _fingerprint;
  const configured = { ...validated, mode: 'release' as const, aggregateCapMicros: aggregate.data };
  return Object.freeze({
    ...configured,
    configFingerprint: createHash('sha256').update(JSON.stringify(configured)).digest('hex'),
  });
}

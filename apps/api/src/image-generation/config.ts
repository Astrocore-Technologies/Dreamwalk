/** Server-owned image provider configuration. No dotenv/files, URLs, or credential values in DTOs. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { defaultImagePolicy, type ImagePolicy, type GenerationRequest } from './contracts';
import {
  FixtureImageProvider,
  OpenAiImageProvider,
  type ImageProvider,
  type ImageReference,
} from './provider';
export const imageRequestProfile = Object.freeze({
  provider: 'openai',
  model: 'gpt-image-2.5-sunburst-2026-09-08',
  size: '1024x1024',
  quality: 'low',
  outputs: 1,
  format: 'png',
  maxPromptUtf8Bytes: 8000,
  maxReferenceImages: 2,
  maxReferencePixels: 4096 * 4096,
});
/** Standard direct Images API rates; never use Batch/cached rates for these requests. */
export const imagePricing = Object.freeze({
  id: 'openai-images-standard-20261031',
  inputTextMicrosPerMillion: 5000000,
  inputImageMicrosPerMillion: 8000000,
  outputImageMicrosPerMillion: 30000000,
  source: 'https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst',
  reviewedAt: '2026-10-31T00:00:00.000Z',
  expiresAt: '2026-11-01T00:00:00.000Z',
});
/** Planning assumptions, never a guaranteed bill or verified token ceiling. No reference-image estimate. */
export const imageEstimateProfile = Object.freeze({
  id: 'openai-no-reference-estimate-20261031',
  textInputTokensAssumption: 8000,
  imageInputTokensAssumption: 0,
  imageOutputTokensEstimate: 196,
  estimatedTextInputMicros: 40000,
  estimatedImageInputMicros: 0,
  estimatedImageOutputMicros: 5880,
  estimatedTotalMicros: 45880,
  operationalReserveMicros: 100000,
  maxReferenceImages: 0,
  source: 'https://developers.openai.com/api/docs/guides/image-generation',
});
const boundSchema = z
  .object({
    evidenceKind: z.enum(['provider_contract', 'verified_token_ceiling']),
    evidenceUrl: z
      .url()
      .max(500)
      .refine((v) => {
        const url = new URL(v);
        return (
          url.protocol === 'https:' &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          ['developers.openai.com', 'platform.openai.com'].includes(url.hostname) &&
          /^[a-zA-Z0-9_/-]*$/.test(url.pathname)
        );
      }),
    verifiedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    model: z.literal(imageRequestProfile.model),
    size: z.literal('1024x1024'),
    quality: z.literal('low'),
    outputs: z.literal(1),
    maxPromptUtf8Bytes: z.literal(8000),
    maxReferenceImages: z.literal(2),
    maxReferencePixels: z.literal(16777216),
    upperMicros: z.number().int().positive().max(1000000),
    // A calculator estimate or allowance is insufficient. Reviewed ceilings must cover ALL billed tokens.
    maxTextInputTokens: z.number().int().nonnegative().max(1000000),
    maxImageInputTokens: z.number().int().nonnegative().max(1000000),
    maxImageOutputTokens: z.number().int().positive().max(1000000),
  })
  .strict()
  .refine(
    (v) =>
      v.upperMicros >=
      Math.ceil(
        (v.maxTextInputTokens * imagePricing.inputTextMicrosPerMillion +
          v.maxImageInputTokens * imagePricing.inputImageMicrosPerMillion +
          v.maxImageOutputTokens * imagePricing.outputImageMicrosPerMillion) /
          1000000,
      ),
  );
export interface ImageCapabilities {
  mockAvailable: boolean;
  externalEnabled: boolean;
  externalBlockReasons: string[];
  requestProfile: Omit<typeof imageRequestProfile, 'maxReferenceImages'> & {
    maxReferenceImages: number;
  };
  pricing: typeof imagePricing;
  verifiedUpperMicros: number | null;
  approvedTotalMicros: number;
  approvedImageMicros: number;
  approvedTextMicros: number;
  costStatus: 'unverified' | 'verified_bound' | 'approved_estimate';
  costBasis: 'unverified' | 'verified_bound' | 'approved_estimate';
  estimatedTotalMicros?: number;
  reserveMicros?: number;
  estimateProfile?: typeof imageEstimateProfile;
  planningEstimate: typeof imageEstimateProfile & {
    costBasis: 'planning_estimate';
    providerEnforcesQuotedCap: false;
  };
  riskApprovalActive: boolean;
  estimateDispatchReleased: false;
  providerEnforcesQuotedCap: false;
  credentialState: 'not_checked' | 'missing' | 'configured';
  boundEvidence?: { kind: string; source: string; verifiedAt: string; expiresAt: string };
}
export interface ImageRuntime {
  provider: ImageProvider;
  policy: ImagePolicy;
  capabilities: ImageCapabilities;
}
class ModeImageProvider implements ImageProvider {
  readonly id: string;
  private fixture = new FixtureImageProvider();
  constructor(private external: ImageProvider | undefined) {
    this.id = `image-router-v1:${this.fixture.id}:${external?.id ?? 'external-disabled'}`;
  }
  async generate(input: GenerationRequest, dispatchId: string, refs: ImageReference[]) {
    if (input.mode === 'mock') return this.fixture.generate(input, dispatchId);
    if (!this.external) throw new Error('LIVE_COST_BOUND_REQUIRED');
    return this.external.generate(input, dispatchId, refs);
  }
}
/** Config is trusted operator input, never accepted from the browser. Tests inject transport and synthetic keys. */
export function createImageRuntime(
  env: Record<string, string | undefined> = process.env,
  dependencies: {
    resolveApiKey?: () => string | undefined;
    fetchImpl?: typeof fetch;
    now?: number;
  } = {},
): ImageRuntime {
  const now = dependencies.now ?? Date.now(),
    reasons: string[] = [];
  if (env.IMAGE_PROVIDER !== 'openai') reasons.push('EXPLICIT_PROVIDER_CONFIGURATION_REQUIRED');
  if (env.IMAGE_EXTERNAL_ENABLED !== 'true') reasons.push('EXTERNAL_GENERATION_DISABLED');
  if (env.IMAGE_NETWORK_APPROVED !== 'true') reasons.push('NETWORK_APPROVAL_REQUIRED');
  if (
    env.IMAGE_SPEND_AUTHORIZED !== 'true' ||
    !/^[a-zA-Z0-9:_-]{1,120}$/.test(env.IMAGE_APPROVAL_ID ?? '')
  )
    reasons.push('SPEND_APPROVAL_REQUIRED');
  if (env.IMAGE_MODEL && env.IMAGE_MODEL !== imageRequestProfile.model)
    reasons.push('UNSUPPORTED_IMAGE_MODEL');
  if (env.IMAGE_PRICING_ID !== imagePricing.id || now >= Date.parse(imagePricing.expiresAt))
    reasons.push('VERIFIED_PRICING_REQUIRED');
  let bound: z.infer<typeof boundSchema> | undefined;
  try {
    const parsed = boundSchema.safeParse(JSON.parse(env.IMAGE_COST_BOUND_JSON ?? 'null'));
    if (
      parsed.success &&
      Date.parse(parsed.data.verifiedAt) <= now &&
      Date.parse(parsed.data.expiresAt) > now
    )
      bound = parsed.data;
  } catch {
    /* Never echo malformed operator input, credentials, or private request content. */
  }
  const estimateRequested = env.IMAGE_COST_MODE === 'estimate';
  if (env.IMAGE_COST_MODE && !['strict', 'estimate'].includes(env.IMAGE_COST_MODE))
    reasons.push('UNSUPPORTED_IMAGE_COST_MODE');
  const riskExpiry = z.iso.datetime().safeParse(env.IMAGE_ESTIMATE_RISK_EXPIRES_AT);
  const estimateApproved =
    estimateRequested &&
    env.IMAGE_ESTIMATE_RISK_APPROVED === 'true' &&
    env.IMAGE_ESTIMATE_PROFILE_ID === imageEstimateProfile.id &&
    /^[a-zA-Z0-9:_-]{1,120}$/.test(env.IMAGE_ESTIMATE_RISK_APPROVAL_ID ?? '') &&
    riskExpiry.success &&
    Date.parse(riskExpiry.data) > now &&
    Date.parse(riskExpiry.data) <= now + 2 * 3600000;
  if (estimateRequested) {
    bound = undefined; // Never reinterpret this estimate as a verified bound, even if a proof is also configured.
    if (!estimateApproved) reasons.push('ESTIMATE_RISK_APPROVAL_REQUIRED');
    // Actual informed owner approval is pending. Environment flags alone must not bypass the rejected dispatch action.
    reasons.push('ESTIMATE_DISPATCH_APPROVAL_PENDING');
  } else if (!bound) reasons.push('VERIFIED_TOTAL_COST_BOUND_REQUIRED');
  const reserve = estimateRequested
    ? imageEstimateProfile.operationalReserveMicros
    : bound?.upperMicros;
  const caps = z
    .object({
      total: z.coerce.number().int().positive().max(2000000),
      image: z.coerce.number().int().positive().max(1000000),
      text: z.coerce.number().int().nonnegative().max(1000000),
    })
    .safeParse({
      total: env.IMAGE_APPROVAL_TOTAL_MICROS,
      image: env.IMAGE_APPROVAL_IMAGE_MICROS,
      text: env.IMAGE_APPROVAL_TEXT_MICROS,
    });
  if (
    !caps.success ||
    (reserve !== undefined &&
      caps.success &&
      (reserve > caps.data.image || reserve > caps.data.total))
  )
    reasons.push('APPROVAL_CAPS_REQUIRED');
  if (estimateRequested && caps.success && caps.data.total > 1000000)
    reasons.push('ESTIMATE_COMBINED_BUDGET_LIMIT_REQUIRED');
  const expiresAt =
    estimateRequested && riskExpiry.success
      ? Date.parse(riskExpiry.data)
      : bound
        ? Date.parse(bound.expiresAt)
        : undefined;
  const costBasis = estimateRequested
    ? ('approved_estimate' as const)
    : ('verified_bound' as const);
  // Keep the pre-existing authorization scope so an unknown older403 liability cannot disappear via config.
  if (env.IMAGE_APPROVAL_SCOPE && env.IMAGE_APPROVAL_SCOPE !== defaultImagePolicy.scopeId)
    reasons.push('BUDGET_SCOPE_CHANGE_REQUIRES_RECONCILIATION');
  let credentialState: ImageCapabilities['credentialState'] = 'not_checked';
  let external: ImageProvider | undefined;
  const resolveApiKey = dependencies.resolveApiKey ?? (() => process.env.OPENAI_API_KEY);
  if (!reasons.length) {
    const key = resolveApiKey();
    const validKey = typeof key === 'string' && /^[^\s]{1,1024}$/.test(key);
    credentialState = validKey ? 'configured' : 'missing';
    if (!validKey) reasons.push('IMAGE_CREDENTIAL_REQUIRED');
    else
      external = new OpenAiImageProvider({
        enabled: true,
        networkApproved: true,
        resolveApiKey,
        verifiedUpperMicros: bound?.upperMicros ?? null,
        costBasis,
        estimateRiskApproved: estimateApproved,
        operationalReserveMicros: estimateRequested
          ? imageEstimateProfile.operationalReserveMicros
          : undefined,
        model: imageRequestProfile.model,
        fetchImpl: dependencies.fetchImpl,
        now: () => dependencies.now ?? Date.now(),
        approvedUntilMs: Math.min(expiresAt!, Date.parse(imagePricing.expiresAt)),
        ...imagePricing,
      });
  }
  const policy: ImagePolicy = Object.freeze({
    ...defaultImagePolicy,
    version: `image-config-v2:${createHash('sha256')
      .update(
        JSON.stringify({
          bound,
          estimateProfile: estimateRequested ? imageEstimateProfile : undefined,
          estimateRequested,
          estimateApproved,
          riskExpiry: riskExpiry.success ? riskExpiry.data : null,
          estimateApproval: env.IMAGE_ESTIMATE_RISK_APPROVAL_ID,
          caps: caps.success ? caps.data : null,
          approval: env.IMAGE_APPROVAL_ID,
          profile: imageRequestProfile,
          pricing: imagePricing.id,
        }),
      )
      .digest('hex')}`,
    externalEnabled: !!external,
    approved: !!external,
    externalExpiresAt: expiresAt
      ? new Date(Math.min(expiresAt, Date.parse(imagePricing.expiresAt))).toISOString()
      : undefined,
    verifiedUpperMicros: bound?.upperMicros ?? null,
    costBasis,
    estimatedTotalMicros: estimateRequested ? imageEstimateProfile.estimatedTotalMicros : undefined,
    operationalReserveMicros: estimateRequested
      ? imageEstimateProfile.operationalReserveMicros
      : undefined,
    totalCapMicros: caps.success ? caps.data.total : defaultImagePolicy.totalCapMicros,
    imageCapMicros: caps.success ? caps.data.image : defaultImagePolicy.imageCapMicros,
    textCapMicros: caps.success ? caps.data.text : defaultImagePolicy.textCapMicros,
  });
  return {
    provider: new ModeImageProvider(external),
    policy,
    capabilities: {
      mockAvailable: true,
      externalEnabled: !!external,
      externalBlockReasons: reasons,
      requestProfile: {
        ...imageRequestProfile,
        maxReferenceImages: estimateRequested ? 0 : imageRequestProfile.maxReferenceImages,
      },
      pricing: imagePricing,
      planningEstimate: {
        ...imageEstimateProfile,
        costBasis: 'planning_estimate',
        providerEnforcesQuotedCap: false,
      },
      verifiedUpperMicros: policy.verifiedUpperMicros,
      approvedTotalMicros: policy.totalCapMicros,
      approvedImageMicros: policy.imageCapMicros,
      approvedTextMicros: policy.textCapMicros,
      costStatus: estimateApproved ? 'approved_estimate' : bound ? 'verified_bound' : 'unverified',
      costBasis: estimateApproved ? 'approved_estimate' : bound ? 'verified_bound' : 'unverified',
      riskApprovalActive: estimateApproved,
      estimateDispatchReleased: false,
      ...(estimateRequested
        ? {
            estimateProfile: imageEstimateProfile,
            estimatedTotalMicros: imageEstimateProfile.estimatedTotalMicros,
            reserveMicros: imageEstimateProfile.operationalReserveMicros,
          }
        : {}),
      providerEnforcesQuotedCap: false,
      credentialState,
      ...(bound
        ? {
            boundEvidence: {
              kind: bound.evidenceKind,
              source: bound.evidenceUrl,
              verifiedAt: bound.verifiedAt,
              expiresAt: bound.expiresAt,
            },
          }
        : {}),
    },
  };
}

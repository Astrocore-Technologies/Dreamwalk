/** Operator planning heuristics, not official tokenization, reference pricing rules, or invoice bounds. */
import { createHash } from 'node:crypto';
import { textInputReserveRate, type TextCachePricing } from './text-pricing';
import {
  measureTextContext,
  assertTextContext,
  type TextContextMeasurement,
  type TextTokenCounter,
} from '../ai/text-context';
export interface TextEstimationPolicy {
  kind: 'operator_heuristic';
  textTokensPerKiBUtf8: number;
  textProtocolTokens: number;
  marginBps: number;
  fixedMarginMicros: number;
}
export interface ImageEstimationPolicy extends TextEstimationPolicy {
  outputImageTokens: number;
  referenceImageTokensPerImage: number;
  referenceAllowanceMicros: number;
}
export interface PricingEvidence {
  source: string;
  reviewedAt: string;
  validUntil: string;
}
export interface TextEstimateProfile {
  cachePricing?: TextCachePricing;
  model: string;
  contextTokens: number;
  contextBudgetTokens?: number;
  maxOutputTokens: number;
  maxInputBytes: number;
  inputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
  pricing?: PricingEvidence;
  estimation?: TextEstimationPolicy;
  upperMicros?: number;
}
export interface ImageEstimateProfile {
  model: string;
  size: string;
  framingPolicy?: {
    version: 1;
    mode: 'map_aspect_reviewed_range';
    assumptionKind: 'operator_range_ceiling_estimate';
    maxAspectRatio: number;
    quality: 'low' | 'medium' | 'high';
    minPixels: number;
    maxPixels: number;
    maxEdge: number;
    reviewedOutputImageTokens: number;
    pricing: PricingEvidence;
  };
  quality: string;
  outputs: number;
  format: string;
  maxPromptUtf8Bytes: number;
  maxReferenceImages: number;
  inputTextMicrosPerMillion: number;
  inputImageMicrosPerMillion: number;
  outputImageMicrosPerMillion: number;
  pricing?: PricingEvidence;
  estimation?: ImageEstimationPolicy;
  estimatedTotalMicros?: number;
  reserveMicros?: number;
}
export interface TextReserveSnapshot {
  cachePricing?: TextCachePricing;
  contextWindow?: TextContextMeasurement;
  schemaVersion: 1;
  id: string;
  fingerprint: string;
  costBasis: 'operator_estimate' | 'legacy_fixed';
  providerEnforcesQuotedCap: false;
  bodySha256: string;
  serializedBytes: number;
  estimatedInputTokens: number;
  bodyInputTokensEstimate: number;
  protocolTokenAllowance: number;
  maxOutputTokens: number;
  contextTokens: number;
  model: string;
  inputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
  pricing?: PricingEvidence;
  inputMicros: number;
  outputMicros: number;
  estimatedTotalMicros: number;
  reserveMicros: number;
  marginBps: number;
  percentageMarginMicros: number;
  fixedMarginMicros: number;
  providerFingerprint: string;
  assumptions: TextEstimationPolicy | null;
}
export interface ImagePricingProfileSnapshot {
  schemaVersion: 1;
  id: string;
  fingerprint: string;
  model: string;
  size: string;
  framingPolicy?: {
    version: 1;
    mode: 'map_aspect_reviewed_range';
    assumptionKind: 'operator_range_ceiling_estimate';
    maxAspectRatio: number;
    quality: 'low' | 'medium' | 'high';
    minPixels: number;
    maxPixels: number;
    maxEdge: number;
    reviewedOutputImageTokens: number;
    pricing: PricingEvidence;
  };
  quality: string;
  outputs: number;
  format: string;
  maxPromptUtf8Bytes: number;
  maxReferenceImages: number;
  inputTextMicrosPerMillion: number;
  inputImageMicrosPerMillion: number;
  outputImageMicrosPerMillion: number;
  pricing?: PricingEvidence;
  estimation: ImageEstimationPolicy | null;
  legacyFixedEstimateMicros?: number;
  legacyFixedReserveMicros?: number;
  providerEnforcesQuotedCap: false;
}
export interface ImageReserveSnapshot {
  schemaVersion: 1;
  id: string;
  fingerprint: string;
  basis: 'operator_heuristic' | 'legacy_fixed';
  costBasis: 'operator_estimate' | 'legacy_fixed';
  providerEnforcesQuotedCap: false;
  promptUtf8Bytes: number;
  promptSha256: string;
  referenceCount: number;
  uncertainReferences: boolean;
  inputTextTokensEstimate: number | null;
  inputImageTokensEstimate: number | null;
  outputImageTokensEstimate: number | null;
  inputTextMicros: number | null;
  inputImageMicros: number | null;
  outputImageMicros: number | null;
  estimatedTotalMicros: number;
  marginBps: number;
  percentageMarginMicros: number;
  fixedMarginMicros: number;
  referenceAllowanceMicros: number;
  reserveMicros: number;
  providerFingerprint: string;
  pricingProfileId: string;
  pricingProfileHash: string;
  assumptions: ImageEstimationPolicy | null;
}
export class RequestEstimationError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'RequestEstimationError';
  }
}
const stable = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .filter(([, x]) => x !== undefined)
            .map(([k, x]) => [k, stable(x)]),
        )
      : v;
export const estimateFingerprint = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
const integer = (n: number, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new RequestEstimationError('GENERATION_ESTIMATION_INVALID');
  return BigInt(n);
};
const numeric = (n: bigint) => {
  if (n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RequestEstimationError('GENERATION_ESTIMATION_OVERFLOW');
  return Number(n);
};
const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
const cost = (tokens: bigint, rate: number) => ceil(tokens * integer(rate, 1), 1000000n);
function policy(p: TextEstimationPolicy) {
  if (p.kind !== 'operator_heuristic')
    throw new RequestEstimationError('GENERATION_ESTIMATION_INVALID');
  integer(p.textTokensPerKiBUtf8, 1, 1048576);
  integer(p.textProtocolTokens, 0, 1048576);
  integer(p.marginBps, 0, 100000);
  integer(p.fixedMarginMicros, 0, 1000000000000);
}
function signed<T extends object>(
  prefix: string,
  value: T,
): T & { id: string; fingerprint: string } {
  const fingerprint = estimateFingerprint(value);
  return { ...value, id: `${prefix}:${fingerprint}`, fingerprint };
}
export function estimateTextRequest(
  serializedBody: string,
  profile: TextEstimateProfile,
  providerFingerprint: string,
  counter?: TextTokenCounter,
): TextReserveSnapshot {
  if (typeof serializedBody !== 'string' || !providerFingerprint)
    throw new RequestEstimationError('GENERATION_ESTIMATION_INVALID');
  const serializedBytes = Buffer.byteLength(serializedBody, 'utf8');
  integer(profile.maxInputBytes, 1);
  integer(profile.maxOutputTokens, 1);
  integer(profile.contextTokens, 1);
  if (serializedBytes > profile.maxInputBytes)
    throw new RequestEstimationError('GENERATION_INPUT_TOO_LARGE');
  const p = profile.estimation;
  if (p) policy(p);
  const contextWindow =
    profile.contextBudgetTokens !== undefined
      ? assertTextContext(measureTextContext(serializedBody, profile, counter))
      : undefined;
  const bodyTokens = contextWindow
    ? BigInt(contextWindow.inputTokens - contextWindow.protocolTokenAllowance)
    : p
      ? ceil(BigInt(serializedBytes) * BigInt(p.textTokensPerKiBUtf8), 1024n)
      : BigInt(profile.contextTokens);
  const protocolTokens = contextWindow
      ? BigInt(contextWindow.protocolTokenAllowance)
      : p
        ? BigInt(p.textProtocolTokens)
        : 0n,
    inputTokens = bodyTokens + protocolTokens;
  if (p && inputTokens + BigInt(profile.maxOutputTokens) > BigInt(profile.contextTokens))
    throw new RequestEstimationError('GENERATION_CONTEXT_ESTIMATE_EXCEEDED');
  const reserveInputRate = textInputReserveRate(profile);
  const inputMicros = cost(inputTokens, reserveInputRate),
    outputMicros = cost(BigInt(profile.maxOutputTokens), profile.outputMicrosPerMillion);
  // Legacy computes the old single rounded combined amount, retaining its historical reserve semantics.
  const estimated = p
    ? inputMicros + outputMicros
    : ceil(
        inputTokens * integer(reserveInputRate, 1) +
          BigInt(profile.maxOutputTokens) * integer(profile.outputMicrosPerMillion, 1),
        1000000n,
      );
  const margin = p ? ceil(estimated * BigInt(p.marginBps), 10000n) : 0n,
    fixed = p ? BigInt(p.fixedMarginMicros) : 0n;
  return signed('text-estimate-v1', {
    schemaVersion: 1 as const,
    ...(contextWindow ? { contextWindow } : {}),
    costBasis: p ? ('operator_estimate' as const) : ('legacy_fixed' as const),
    providerEnforcesQuotedCap: false as const,
    bodySha256: createHash('sha256').update(serializedBody, 'utf8').digest('hex'),
    serializedBytes,
    estimatedInputTokens: numeric(inputTokens),
    bodyInputTokensEstimate: numeric(bodyTokens),
    protocolTokenAllowance: numeric(protocolTokens),
    maxOutputTokens: profile.maxOutputTokens,
    contextTokens: profile.contextTokens,
    model: profile.model,
    inputMicrosPerMillion: profile.inputMicrosPerMillion,
    outputMicrosPerMillion: profile.outputMicrosPerMillion,
    ...(profile.cachePricing ? { cachePricing: { ...profile.cachePricing } } : {}),
    ...(profile.pricing ? { pricing: { ...profile.pricing } } : {}),
    inputMicros: numeric(inputMicros),
    outputMicros: numeric(outputMicros),
    estimatedTotalMicros: numeric(estimated),
    reserveMicros: numeric(estimated + margin + fixed),
    marginBps: p?.marginBps ?? 0,
    percentageMarginMicros: numeric(margin),
    fixedMarginMicros: numeric(fixed),
    providerFingerprint,
    assumptions: p ? { ...p } : null,
  });
}
export function imagePricingProfileSnapshot(
  profile: ImageEstimateProfile,
): ImagePricingProfileSnapshot {
  return signed('image-profile-v1', {
    schemaVersion: 1 as const,
    model: profile.model,
    size: profile.size,
    ...(profile.framingPolicy
      ? {
          framingPolicy: {
            ...profile.framingPolicy,
            pricing: { ...profile.framingPolicy.pricing },
          },
        }
      : {}),
    quality: profile.quality,
    outputs: profile.outputs,
    format: profile.format,
    maxPromptUtf8Bytes: profile.maxPromptUtf8Bytes,
    maxReferenceImages: profile.maxReferenceImages,
    inputTextMicrosPerMillion: profile.inputTextMicrosPerMillion,
    inputImageMicrosPerMillion: profile.inputImageMicrosPerMillion,
    outputImageMicrosPerMillion: profile.outputImageMicrosPerMillion,
    ...(profile.pricing ? { pricing: { ...profile.pricing } } : {}),
    estimation: profile.estimation ? { ...profile.estimation } : null,
    ...(!profile.estimation
      ? {
          legacyFixedEstimateMicros: profile.estimatedTotalMicros,
          legacyFixedReserveMicros: profile.reserveMicros,
        }
      : {}),
    providerEnforcesQuotedCap: false as const,
  });
}
export function estimateImageRequest(
  prompt: string,
  referenceCount: number,
  profile: ImageEstimateProfile,
  providerFingerprint: string,
  estimateIsReservation = false,
): ImageReserveSnapshot {
  if (typeof prompt !== 'string' || !providerFingerprint)
    throw new RequestEstimationError('GENERATION_ESTIMATION_INVALID');
  const bytes = Buffer.byteLength(prompt, 'utf8');
  integer(profile.maxPromptUtf8Bytes, 1);
  integer(profile.maxReferenceImages, 0, 2);
  integer(referenceCount, 0, profile.maxReferenceImages);
  integer(profile.outputs, 1, 1);
  if (bytes > profile.maxPromptUtf8Bytes)
    throw new RequestEstimationError('GENERATION_INPUT_TOO_LARGE');
  const pricing = imagePricingProfileSnapshot(profile),
    p = profile.estimation;
  let textTokens: bigint | null = null,
    imageTokens: bigint | null = null,
    outputTokens: bigint | null = null,
    textCost: bigint | null = null,
    imageCost: bigint | null = null,
    outputCost: bigint | null = null,
    total: bigint,
    margin = 0n,
    fixed = 0n,
    referenceAllowance = 0n,
    reserve: bigint;
  if (p) {
    policy(p);
    integer(p.outputImageTokens, 1, 1048576);
    integer(p.referenceImageTokensPerImage, 0, 1048576);
    integer(p.referenceAllowanceMicros, 0, 1000000000000);
    textTokens =
      ceil(BigInt(bytes) * BigInt(p.textTokensPerKiBUtf8), 1024n) + BigInt(p.textProtocolTokens);
    imageTokens = BigInt(referenceCount) * BigInt(p.referenceImageTokensPerImage);
    outputTokens = BigInt(profile.outputs) * BigInt(p.outputImageTokens);
    textCost = cost(textTokens, profile.inputTextMicrosPerMillion);
    imageCost = cost(imageTokens, profile.inputImageMicrosPerMillion);
    outputCost = cost(outputTokens, profile.outputImageMicrosPerMillion);
    total = textCost + imageCost + outputCost;
    margin = ceil(total * BigInt(p.marginBps), 10000n);
    fixed = BigInt(p.fixedMarginMicros);
    referenceAllowance = BigInt(referenceCount) * BigInt(p.referenceAllowanceMicros);
    reserve = total + margin + fixed + referenceAllowance;
  } else {
    total = integer(profile.estimatedTotalMicros!, 1);
    reserve = estimateIsReservation ? total : integer(profile.reserveMicros!, 1);
    if (reserve < total) throw new RequestEstimationError('GENERATION_ESTIMATION_INVALID');
    fixed = reserve - total;
  }
  return signed('image-estimate-v1', {
    schemaVersion: 1 as const,
    basis: p ? ('operator_heuristic' as const) : ('legacy_fixed' as const),
    costBasis: p ? ('operator_estimate' as const) : ('legacy_fixed' as const),
    providerEnforcesQuotedCap: false as const,
    promptUtf8Bytes: bytes,
    promptSha256: createHash('sha256').update(prompt, 'utf8').digest('hex'),
    referenceCount,
    uncertainReferences: referenceCount > 0,
    inputTextTokensEstimate: textTokens === null ? null : numeric(textTokens),
    inputImageTokensEstimate: imageTokens === null ? null : numeric(imageTokens),
    outputImageTokensEstimate: outputTokens === null ? null : numeric(outputTokens),
    inputTextMicros: textCost === null ? null : numeric(textCost),
    inputImageMicros: imageCost === null ? null : numeric(imageCost),
    outputImageMicros: outputCost === null ? null : numeric(outputCost),
    estimatedTotalMicros: numeric(total),
    marginBps: p?.marginBps ?? 0,
    percentageMarginMicros: numeric(margin),
    fixedMarginMicros: numeric(fixed),
    referenceAllowanceMicros: numeric(referenceAllowance),
    reserveMicros: numeric(reserve),
    providerFingerprint,
    pricingProfileId: pricing.id,
    pricingProfileHash: pricing.fingerprint,
    assumptions: p ? { ...p } : null,
  });
}

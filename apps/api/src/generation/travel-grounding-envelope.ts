import { digest } from '../ai/context';
import { usesStoryExactCount } from '../ai/story-vision';
import { textInputReserveRate } from './text-pricing';
import type { AuthoringTextProfile } from '../live-test/authoring-provider';
import type { TextReserveSnapshot } from './estimates';

/** Honest future-input allowance, NEVER an exact request snapshot or known image-token count. */
export type TravelGroundingEnvelope = {
  version: 1;
  kind: 'one_future_travel_raster';
  settlementPolicy: 'known-cost-v1';
  preparationId: string;
  sourceChecksum: string;
  imageRequestHash: string;
  authorizationId: string;
  policyRevision: number;
  policyHash: string;
  providerVersion: string;
  profileHash: string;
  maxRequests: 1;
  maxOperationalCounts: 1;
  maxImages: 1;
  maxInputTokens: number;
  maxOutputTokens: number;
  reserveMicros: number;
  estimatedTotalMicros: number;
  fingerprint: string;
};
export function travelGroundingEnvelope(
  profile: AuthoringTextProfile,
  providerVersion: string,
  source: {
    preparationId: string;
    sourceChecksum: string;
    imageRequestHash: string;
    authorizationId: string;
    policyRevision: number;
    policyHash: string;
  },
): TravelGroundingEnvelope {
  if (
    !profile.estimation ||
    !usesStoryExactCount(profile.storyVision) ||
    !profile.contextBudgetTokens
  )
    throw Error('MAP_VISION_POLICY_REQUIRED');
  const maxInputTokens = Math.min(16384, profile.contextBudgetTokens - profile.maxOutputTokens);
  if (maxInputTokens < 4096) throw Error('MAP_VISION_POLICY_REQUIRED');
  const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
  const estimated =
    ceil(BigInt(maxInputTokens) * BigInt(textInputReserveRate(profile)), 1000000n) +
    ceil(BigInt(profile.maxOutputTokens) * BigInt(profile.outputMicrosPerMillion), 1000000n);
  const reserve =
    estimated +
    ceil(estimated * BigInt(profile.estimation.marginBps), 10000n) +
    BigInt(profile.estimation.fixedMarginMicros);
  if (reserve <= 0n || reserve > BigInt(Number.MAX_SAFE_INTEGER))
    throw Error('GENERATION_ESTIMATION_OVERFLOW');
  const body = {
    version: 1 as const,
    kind: 'one_future_travel_raster' as const,
    settlementPolicy: 'known-cost-v1' as const,
    ...source,
    providerVersion,
    profileHash: digest(profile),
    maxRequests: 1 as const,
    maxOperationalCounts: 1 as const,
    maxImages: 1 as const,
    maxInputTokens,
    maxOutputTokens: profile.maxOutputTokens,
    reserveMicros: Number(reserve),
    estimatedTotalMicros: Number(estimated),
  };
  return { ...body, fingerprint: digest(body) };
}
export function assertTravelGroundingSnapshot(
  envelope: TravelGroundingEnvelope,
  snapshot: TextReserveSnapshot,
  profile: AuthoringTextProfile,
  providerVersion: string,
) {
  const { fingerprint, ...body } = envelope;
  if (
    fingerprint !== digest(body) ||
    providerVersion !== envelope.providerVersion ||
    digest(profile) !== envelope.profileHash ||
    snapshot.providerFingerprint !== providerVersion ||
    snapshot.contextWindow?.precision !== 'exact' ||
    snapshot.estimatedInputTokens > envelope.maxInputTokens ||
    snapshot.maxOutputTokens !== envelope.maxOutputTokens ||
    snapshot.reserveMicros > envelope.reserveMicros ||
    snapshot.model !== profile.model
  )
    throw Error('LOCATION_GROUNDING_ALLOWANCE_EXCEEDED');
}

/** Bound every child and its future-input allowance into the same visible consent. */
export function travelGroundingConsentHash(entries: unknown[], mediaEntries: unknown[]) {
  return digest({ version: 'travel-grounding-v1', entries, mediaEntries });
}

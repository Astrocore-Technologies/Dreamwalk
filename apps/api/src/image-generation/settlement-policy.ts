import { digest } from '../ai/context';

export const AUTOMATIC_IMAGE_SETTLEMENT_POLICY = 'known-cost-v1' as const;
/** Disclosed as part of the existing single quote/risk consent, never a second action.
 * The policy cannot expand the original reserve or authorize retry/admission. */
export function imageKnownCostPolicy(input: {
  quoteId: string;
  requestHash: string;
  reserveMicros: string;
  costBasis: string;
}) {
  const policy = {
    version: AUTOMATIC_IMAGE_SETTLEMENT_POLICY,
    ...input,
    knownFailureSettlement: 'capture-verified-cost-release-remainder' as const,
    unknownOrOverrun: 'retain' as const,
    automaticRetry: false as const,
  };
  return { ...policy, fingerprint: digest(policy) };
}
export function imageKnownCostConsentMatches(
  native: { id: string; request_hash: string; upper_micros: string; cost_basis: string },
  acceptedFingerprint: string | undefined,
) {
  return (
    acceptedFingerprint ===
    imageKnownCostPolicy({
      quoteId: native.id,
      requestHash: native.request_hash,
      reserveMicros: String(native.upper_micros),
      costBasis: native.cost_basis,
    }).fingerprint
  );
}

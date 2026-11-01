import type { ImageFraming } from '@dreamwalk/contracts';
import type { ArtRevision } from '../assets/types';
import type { LiveTestStatus } from '../live-test/types';
import type {
  RequestEstimateSnapshot,
  RequestPricingProfileSnapshot,
} from '../live-test/request-reserve-types';
export type ImageConfiguration = {
  requestEstimationEnabled?: boolean;
  pricingProfileId?: string;
  pricingProfileHash?: string;

  providerFingerprint?: string;
  generationMode?: 'owner' | 'manual';
  ownerEstimateEnabled?: boolean;
  estimateRiskConsentRequired?: boolean;
  providerEnforcesQuotedCap?: boolean;
  externalEnabled: boolean;
  externalBlockReasons?: string[];
  verifiedUpperMicros: number | null;
  costStatus?: 'verified_bound' | 'unverified' | 'approved_estimate';
  estimatedTotalMicros?: number;
  reserveMicros?: number;
  requestProfile?: {
    provider?: string;
    model: string;
    size: string;
    framingPolicy?: {
      mode: string;
      minPixels: number;
      maxPixels: number;
      maxEdge: number;
      maxAspectRatio: number;
    };
    quality: string;
    outputs: number;
    maxReferenceImages?: number;
  };
};
export type GenerationQuote = {
  framingVersion?: 1;
  imageFraming?: ImageFraming | null;
  sparks?: { quoteId: string; reserveSubunits: string; rateVersion: string; walletCharging: true };
  pricingProfileId?: string;
  pricingProfileHash?: string;
  basePricingProfileId?: string;
  basePricingProfileHash?: string;
  estimateSnapshot?: RequestEstimateSnapshot;
  pricingProfileSnapshot?: RequestPricingProfileSnapshot;
  estimateSnapshotId?: string;
  estimateSnapshotHash?: string;
  policyRevision?: number;
  policyHash?: string;
  generationMode?: 'owner' | 'manual';
  estimateRiskConsentRequired?: boolean;
  providerEnforcesQuotedCap?: boolean;
  id: string;
  mode: 'mock' | 'external';
  upperMicros: number | null;
  reserveMicros?: number;
  estimatedTotalMicros?: number;
  costBasis?: 'approved_estimate';
  expiresAt: string;
  rightsAttestationRequired: true;
};
export type GenerationItem = {
  role: string;
  dispatchOperationId?: string;
  stage: string;
  status: string;
  quote?: { decision: 'reuse' | 'quote'; matches: ArtRevision[]; quote?: GenerationQuote } | null;
  job?: {
    sparkStatus?: string;
    sparkReservedSubunits?: string;
    sparkCapturedSubunits?: string | null;

    id: string;
    operationId: string;
    status: string;
    mode: 'mock' | 'external';
    revisionId?: string;
    errorCode?: string;
    diagnostic?: { httpStatus: number; billing: 'unknown' };
    heldMicros: number;
    actualMicros?: number;
    createdAt: string;
    canCancel: boolean;
  };
  revisionId?: string;
  url?: string;
  validation?: {
    valid: boolean;
    code?: string;
    width?: number;
    height?: number;
    nonemptyFrames?: number;
  };
};
export type GenerationState = {
  projectId: string;
  projectRevision?: number;
  mode: 'fixture' | 'external';
  requiredRoles: string[];
  items: GenerationItem[];
  readyForReview: boolean;
  automaticRetry: false;
  humanVisualReviewRequired: true;
  configuration: ImageConfiguration;
};
export type GenerationProject = {
  id: string;
  revision: number;
  kind: 'character' | 'location';
  status: string;
};
export const admittedConcept = (state: GenerationState | null) =>
  !!state?.items.some(
    (item) => item.role === 'concept' && !!item.revisionId && item.validation?.valid,
  );

// Request reserves are server snapshots, never a provider invoice guarantee.
const nonnegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const positiveInteger = (value: unknown): value is number => nonnegativeInteger(value) && value > 0;
export const ownerImageEstimateAvailable = (config: ImageConfiguration | null | undefined) =>
  config?.generationMode === 'owner' &&
  config.externalEnabled &&
  config.ownerEstimateEnabled === true &&
  config.estimateRiskConsentRequired === true &&
  config.providerEnforcesQuotedCap === false &&
  config.verifiedUpperMicros === null &&
  (config.requestEstimationEnabled === true
    ? !!config.pricingProfileId && !!config.pricingProfileHash
    : positiveInteger(config.estimatedTotalMicros) &&
      positiveInteger(config.reserveMicros) &&
      config.reserveMicros >= config.estimatedTotalMicros);
export const ownerImageQuoteMatches = (
  quote:
    | {
        mode: string;
        generationMode?: 'owner' | 'manual';
        estimateRiskConsentRequired?: boolean;
        providerEnforcesQuotedCap?: boolean;
        costBasis?: string;
        upperMicros: number | null;
        estimatedTotalMicros?: number;
        reserveMicros?: number;
        estimateSnapshot?: RequestEstimateSnapshot;
        pricingProfileSnapshot?: RequestPricingProfileSnapshot;
        estimateSnapshotId?: string;
        estimateSnapshotHash?: string;
        pricingProfileId?: string;
        pricingProfileHash?: string;
        basePricingProfileId?: string;
        basePricingProfileHash?: string;
        policyRevision?: number;
        policyHash?: string;
      }
    | null
    | undefined,
  config: ImageConfiguration | null | undefined,
  authorization?: LiveTestStatus | null,
) => {
  if (
    !ownerImageEstimateAvailable(config) ||
    quote?.mode !== 'external' ||
    quote.generationMode !== 'owner' ||
    quote.estimateRiskConsentRequired !== true ||
    quote.providerEnforcesQuotedCap !== false ||
    quote.costBasis !== 'approved_estimate' ||
    quote.upperMicros !== null ||
    !positiveInteger(quote.estimatedTotalMicros) ||
    !positiveInteger(quote.reserveMicros) ||
    quote.reserveMicros < quote.estimatedTotalMicros
  )
    return false;
  if (
    authorization?.policyRevision !== undefined &&
    (quote.policyRevision !== authorization.policyRevision ||
      quote.policyHash !== authorization.policyHash)
  )
    return false;
  const estimate = quote.estimateSnapshot,
    pricing = quote.pricingProfileSnapshot;
  if (estimate || pricing || config?.requestEstimationEnabled) {
    if (
      !estimate ||
      !pricing ||
      estimate.schemaVersion !== 1 ||
      estimate.providerEnforcesQuotedCap !== false ||
      pricing.providerEnforcesQuotedCap !== false ||
      !['operator_heuristic', 'legacy_fixed'].includes(estimate.basis) ||
      estimate.estimatedTotalMicros !== quote.estimatedTotalMicros ||
      estimate.reserveMicros !== quote.reserveMicros ||
      estimate.id !== quote.estimateSnapshotId ||
      estimate.fingerprint !== quote.estimateSnapshotHash ||
      pricing.id !== quote.pricingProfileId ||
      pricing.fingerprint !== quote.pricingProfileHash ||
      estimate.pricingProfileId !== pricing.id ||
      estimate.pricingProfileHash !== pricing.fingerprint ||
      (config?.requestProfile?.framingPolicy?.mode === 'map_aspect_reviewed_range'
        ? quote.basePricingProfileId !== config.pricingProfileId ||
          quote.basePricingProfileHash !== config.pricingProfileHash
        : pricing.id !== config?.pricingProfileId ||
          pricing.fingerprint !== config?.pricingProfileHash) ||
      (config?.providerFingerprint !== undefined &&
        estimate.providerFingerprint !== config.providerFingerprint) ||
      !nonnegativeInteger(estimate.promptUtf8Bytes) ||
      !nonnegativeInteger(estimate.referenceCount) ||
      (estimate.referenceCount > 0 && estimate.uncertainReferences !== true)
    )
      return false;
    if (estimate.basis === 'operator_heuristic') {
      const parts = [
        estimate.inputTextMicros,
        estimate.inputImageMicros,
        estimate.outputImageMicros,
      ];
      const margins = [
        estimate.percentageMarginMicros,
        estimate.fixedMarginMicros,
        estimate.referenceAllowanceMicros,
      ];
      if (
        !parts.every(nonnegativeInteger) ||
        !margins.every(nonnegativeInteger) ||
        !nonnegativeInteger(estimate.marginBps) ||
        parts.reduce<number>((sum, value) => sum + (value ?? 0), 0) !==
          quote.estimatedTotalMicros ||
        quote.estimatedTotalMicros +
          margins.reduce<number>((sum, value) => sum + (value ?? 0), 0) !==
          quote.reserveMicros
      )
        return false;
    }
    return true;
  }
  // Persisted pre-snapshot quotes retain the old fixed-profile fence.
  return (
    quote.estimatedTotalMicros === config?.estimatedTotalMicros &&
    quote.reserveMicros === config?.reserveMicros
  );
};

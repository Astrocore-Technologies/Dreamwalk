import type { ArtRevision } from '../assets/types';
export type ImageConfiguration = {
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
    quality: string;
    outputs: number;
    maxReferenceImages?: number;
  };
};
export type GenerationQuote = {
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

// An estimate is not an upper bound. Only the explicitly configured owner path
// may offer risk consent; legacy manual estimates remain non-dispatchable.
export const ownerImageEstimateAvailable = (config: ImageConfiguration | null | undefined) =>
  config?.generationMode === 'owner' &&
  config.externalEnabled &&
  config.ownerEstimateEnabled === true &&
  config.estimateRiskConsentRequired === true &&
  config.providerEnforcesQuotedCap === false &&
  config.verifiedUpperMicros === null &&
  Number.isSafeInteger(config.estimatedTotalMicros) &&
  (config.estimatedTotalMicros ?? 0) > 0 &&
  Number.isSafeInteger(config.reserveMicros) &&
  (config.reserveMicros ?? 0) >= (config.estimatedTotalMicros ?? Infinity);
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
      }
    | null
    | undefined,
  config: ImageConfiguration | null | undefined,
) =>
  ownerImageEstimateAvailable(config) &&
  quote?.mode === 'external' &&
  quote.generationMode === 'owner' &&
  quote.estimateRiskConsentRequired === true &&
  quote.providerEnforcesQuotedCap === false &&
  quote.costBasis === 'approved_estimate' &&
  quote.upperMicros === null &&
  quote.estimatedTotalMicros === config?.estimatedTotalMicros &&
  quote.reserveMicros === config?.reserveMicros;

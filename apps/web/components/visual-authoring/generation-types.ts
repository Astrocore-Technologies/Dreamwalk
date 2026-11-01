import type { ArtRevision } from '../assets/types';
export type ImageConfiguration = {
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
  };
};
export type GenerationQuote = {
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

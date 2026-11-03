/** Admin-only reviewed policy metadata. No credentials or authored content. */
export interface ReleasePolicyProfile {
  mode: 'release';
  allowance?: 'unlimited';
  totalCapMicros: number | null;
  textCapMicros: number | null;
  imageCapMicros: number | null;
  aggregateCapMicros: number | null;
  text: {
    model: string;
    maxOutputTokens: number;
    storyPlanMaxOutputTokens?: number;
    inputMicrosPerMillion: number;
    outputMicrosPerMillion: number;
    upperMicros: number;
    pricing: { source: string; reviewedAt: string; validUntil: string };
  };
  image: {
    model: string;
    estimatedTotalMicros: number;
    reserveMicros: number;
    pricing: { source: string; reviewedAt: string; validUntil: string };
  };
}
export interface ReleasePolicyReview {
  authorizationId: string;
  scopeId: string;
  active: { revision: number; hash: string; profile: ReleasePolicyProfile | null };
  proposed: {
    candidateFingerprint: string;
    profile: ReleasePolicyProfile;
    canApply: boolean;
    blockers: string[];
  };
  liabilities: {
    spentMicros: number;
    heldMicros: number;
    unknownMicros: number;
    totalAccountedMicros: number;
    text: { spentMicros: number; heldMicros: number; unknownMicros: number };
    image: { spentMicros: number; heldMicros: number; unknownMicros: number };
  };
  pendingSparkHolds: { id: string; status: 'held' | 'pending'; reservedSubunits: string }[];
  legacyProfileStatus: 'available' | 'unavailable';
}
export interface ReleasePolicyAdoption {
  operationId: string;
  expectedRevision: number;
  expectedHash: string;
  candidateFingerprint: string;
  consent: true;
}
export interface ReleasePolicyReceipt {
  operationId: string;
  status: 'applied';
  revision: number;
  hash: string;
  candidateFingerprint: string;
  acknowledgedAt: string;
}

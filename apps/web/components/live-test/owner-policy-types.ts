export type PolicyPricing = { source: string; reviewedAt: string; validUntil: string };
export type PolicyProfile = {
  configFingerprint?: string;
  totalCapMicros: number;
  textCapMicros: number;
  imageCapMicros: number;
  text: {
    model: string;
    contextTokens: number;
    contextBudgetTokens?: number;
    counting?: { kind: 'owner_reviewed_fixed'; microsPerRequest: number; pricing: PolicyPricing };
    maxOutputTokens: number;
    maxInputBytes: number;
    inputMicrosPerMillion: number;
    outputMicrosPerMillion: number;
    pricing: PolicyPricing;
    estimation?: Record<string, number | string | boolean>;
  };
  image: {
    model: string;
    size: string;
    quality: string;
    outputs: number;
    maxPromptUtf8Bytes: number;
    maxReferenceImages: number;
    inputTextMicrosPerMillion: number;
    inputImageMicrosPerMillion: number;
    outputImageMicrosPerMillion: number;
    estimatedTotalMicros: number;
    reserveMicros: number;
    estimation?: Record<string, number | string | boolean>;
    pricing: PolicyPricing;
  };
};
export type PolicyHistory = {
  revision: number;
  hash: string;
  previousHash?: string;
  configFingerprint: string;
  acknowledgedAt: string;
  operationId: string;
  profile: PolicyProfile | null;
};
export type PolicyReview = {
  mode: string;
  authorizationId: string | null;
  scopeId: string;
  active: {
    revision: number;
    hash: string;
    configFingerprint: string;
    profile: PolicyProfile | null;
    acknowledgedAt: string | null;
    legacy: boolean;
  } | null;
  proposed: {
    candidateFingerprint: string;
    hash: string;
    profile: PolicyProfile;
    canApply: boolean;
    blockers: string[];
  } | null;
  history: PolicyHistory[];
  liabilities: {
    spentMicros: number;
    heldMicros: number;
    unknownMicros: number;
    totalAccountedMicros: number;
    text: { spentMicros: number; heldMicros: number; unknownMicros: number };
    image: { spentMicros: number; heldMicros: number; unknownMicros: number };
  };
  dispatchEnabled: boolean;
  blockers: string[];
  legacyProfileStatus: 'available' | 'unavailable' | 'unclaimed';
};
export type PolicyApply = {
  operationId: string;
  expectedRevision: number;
  expectedHash: string;
  candidateFingerprint: string;
  consent: true;
};
export type PolicyReceipt =
  | {
      operationId: string;
      status: 'applied';
      revision: number;
      hash: string;
      candidateFingerprint: string;
      acknowledgedAt: string;
    }
  | { operationId: string; status: 'not_found' };
export const validPendingPolicyApply = (value: unknown): value is PolicyApply => {
  if (!value || typeof value !== 'object') return false;
  const p = value as Partial<PolicyApply>;
  return (
    typeof p.operationId === 'string' &&
    /^[a-f0-9-]{36}$/i.test(p.operationId) &&
    Number.isSafeInteger(p.expectedRevision) &&
    (p.expectedRevision ?? -1) >= 0 &&
    typeof p.expectedHash === 'string' &&
    /^[a-f0-9]{64}$/i.test(p.expectedHash) &&
    typeof p.candidateFingerprint === 'string' &&
    /^[a-f0-9]{64}$/i.test(p.candidateFingerprint) &&
    p.consent === true
  );
};

export const policyRetryMatches = (pending: PolicyApply | null, policy: PolicyReview | null) =>
  !!pending &&
  !!policy?.active &&
  !!policy.proposed?.canApply &&
  pending.expectedRevision === policy.active.revision &&
  pending.expectedHash === policy.active.hash &&
  pending.candidateFingerprint === policy.proposed.candidateFingerprint;

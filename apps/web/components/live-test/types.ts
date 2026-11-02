import type { TextRequestEstimateSnapshot } from './request-reserve-types';
export type TurnFence = { roundId: string; phaseEpoch: number; rulesetVersion: 1 };
export type LiveTestStatus = {
  ownerId?: string;
  imageOnlyAdmission?: boolean;
  retainedImageHoldMicros?: number;
  imageActiveHeldMicros?: number;
  policyRevision?: number;
  policyHash?: string | null;
  configFingerprint?: string;
  activeConfigFingerprint?: string | null;
  enabled: boolean;
  mode?: 'manual' | 'owner' | 'release';
  authorizationId?: string | null;
  sessionId: string | null;
  state: 'unclaimed' | 'active' | 'stopped' | 'expired';
  expiresAt: string | null;
  pricingValidUntil?: string | null;
  stopCode?: string | null;
  allowance?: 'unlimited';
  capMicros: number | null;
  textCapMicros?: number | null;
  imageCapMicros?: number | null;
  textUsedMicros?: number;
  imageUsedMicros?: number;
  textRemainingMicros?: number;
  imageRemainingMicros?: number;
  usedMicros: number;
  heldMicros: number;
  remainingMicros: number;
  priorHeldReservations: number;
  imagesEnabled: boolean;
  imageConfiguration?: { requestProfile?: { maxReferenceImages?: number } | null };
  imageBlockCode?: string;
  text: {
    model: string;
    upperMicros: number;
    maxOutputTokens: number;
    contextTokens: number;
    contextBudgetTokens?: number;
    costEvidence: string;
    pricingSource?: string;
    reasoningEffort?: string;
  };
};
export type TextCountReceipt = {
  id: string;
  status: string;
  inputTokens: number | null;
  actualMicros: number | null;
  resultCode: string | null;
  costBasis: string;
  invoiceExact: false;
};
export type TextCountView = {
  blockCode: string | null;
  candidateFingerprint: string;
  historyRecords: number;
  reserveMicros: number | null;
  attempts: number;
  maxAttempts: number;
  latest: TextCountReceipt | null;
};
export type LiveRequest = {
  counting?: TextCountView;
  errorCode?: string | null;
  configFingerprint?: string | null;
  estimateSnapshot?: TextRequestEstimateSnapshot | null;
  reserveMicros?: number;
  policyRevision?: number;
  policyHash?: string;
  id: string;
  subjectId: string;
  purpose: string;
  permitState: null | 'authorized' | 'dispatched' | 'settled' | 'unknown' | 'cancelled';
  upperMicros: number | null;
};
export type LiveRequests = { turnFence: TurnFence; requests: LiveRequest[] };
export const generationAuthorizationId = (value: LiveTestStatus | null) =>
  value?.authorizationId ?? value?.sessionId ?? null;
export const generationExpired = (value: LiveTestStatus, now = Date.now()) =>
  value.mode === 'owner' || value.mode === 'release'
    ? false
    : !value.expiresAt ||
      !Number.isFinite(Date.parse(value.expiresAt)) ||
      Date.parse(value.expiresAt) <= now;
export const generationPricingCurrent = (value: LiveTestStatus, now = Date.now()) =>
  !value.pricingValidUntil || Date.parse(value.pricingValidUntil) > now;
export const liveSessionActive = (value: LiveTestStatus | null, now = Date.now()) =>
  !!value &&
  value.enabled &&
  value.state === 'active' &&
  (value.mode === 'release' || !!generationAuthorizationId(value)) &&
  !generationExpired(value, now) &&
  generationPricingCurrent(value, now) &&
  value.remainingMicros > 0;
/** Image-only admission never activates text or settles old liabilities. */
export const imageSessionActive = (value: LiveTestStatus | null, now = Date.now()) =>
  liveSessionActive(value, now) ||
  (!!value &&
    value.mode === 'owner' &&
    value.imageOnlyAdmission === true &&
    value.imagesEnabled &&
    liveSessionActive({ ...value, state: 'active' }, now));
/** Release creates authority on the first quoted POST; legacy modes still need a grant ID. */
export const imageQuoteAuthorizationAvailable = (
  value: LiveTestStatus | null,
  legacyAuthorizationId?: string | null,
  now = Date.now(),
) =>
  value?.mode === 'release'
    ? value.imagesEnabled && imageSessionActive(value, now)
    : !!(generationAuthorizationId(value) ?? legacyAuthorizationId);
export const sameTurnFence = (a?: TurnFence, b?: TurnFence) =>
  !!a &&
  !!b &&
  a.roundId === b.roundId &&
  a.phaseEpoch === b.phaseEpoch &&
  a.rulesetVersion === b.rulesetVersion;
export function formatUsd(value: number, locale = 'en') {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(value / 1_000_000);
}

/** Invalidates delayed UI responses even when navigation returns to the same scope. */
export class GenerationResponseScope {
  private key: string | null = null;
  private epoch = 0;
  update(key: string) {
    if (key !== this.key) {
      this.key = key;
      this.epoch++;
    }
  }
  capture() {
    return this.epoch;
  }
  current(stamp: number) {
    return stamp === this.epoch;
  }
  invalidate() {
    this.epoch++;
  }
}

export const generationRemaining = (value: LiveTestStatus | null, purpose: 'text' | 'image') => {
  if (!value) return 0;
  return Math.max(
    0,
    Math.min(
      value.remainingMicros,
      (purpose === 'text' ? value.textRemainingMicros : value.imageRemainingMicros) ??
        value.remainingMicros,
    ),
  );
};

export const liveRequestReserve = (request: LiveRequest): number | null => {
  const value = request.reserveMicros ?? request.upperMicros;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
  const estimate = request.estimateSnapshot;
  if (
    estimate &&
    (estimate.schemaVersion !== 1 ||
      estimate.providerEnforcesQuotedCap !== false ||
      estimate.reserveMicros !== value ||
      !Number.isSafeInteger(estimate.estimatedTotalMicros) ||
      estimate.estimatedTotalMicros < 0 ||
      value < estimate.estimatedTotalMicros)
  )
    return null;
  return value;
};
export const liveRequestPolicyCurrent = (request: LiveRequest, status: LiveTestStatus) =>
  status.policyRevision === undefined ||
  (request.policyRevision === status.policyRevision && request.policyHash === status.policyHash);

export const liveRequestConsentFence = (
  request: LiveRequest,
  authorization?: Pick<LiveTestStatus, 'mode'> | null,
): { estimateFingerprint?: string; policyRevision?: number; policyHash?: string } | null => {
  const heuristic = request.estimateSnapshot?.costBasis === 'operator_estimate';
  if (authorization?.mode !== 'owner' && authorization?.mode !== 'release' && !heuristic) return {};
  if (
    !Number.isSafeInteger(request.policyRevision) ||
    (request.policyRevision ?? -1) < 0 ||
    typeof request.policyHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(request.policyHash)
  )
    return null;
  if (heuristic && !/^[a-f0-9]{64}$/.test(request.estimateSnapshot!.fingerprint)) return null;
  return {
    policyRevision: request.policyRevision,
    policyHash: request.policyHash,
    ...(heuristic ? { estimateFingerprint: request.estimateSnapshot!.fingerprint } : {}),
  };
};

export const ownerClaimFingerprintCurrent = (status: LiveTestStatus) =>
  status.mode !== 'owner' ||
  (typeof status.configFingerprint === 'string' && /^[a-f0-9]{64}$/.test(status.configFingerprint));

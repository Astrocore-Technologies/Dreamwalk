export type TurnFence = { roundId: string; phaseEpoch: number; rulesetVersion: 1 };
export type LiveTestStatus = {
  enabled: boolean;
  mode?: 'manual' | 'owner';
  authorizationId?: string | null;
  sessionId: string | null;
  state: 'unclaimed' | 'active' | 'stopped' | 'expired';
  expiresAt: string | null;
  pricingValidUntil?: string | null;
  stopCode?: string | null;
  capMicros: number;
  textCapMicros?: number;
  imageCapMicros?: number;
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
    costEvidence: string;
    pricingSource?: string;
    reasoningEffort?: string;
  };
};
export type LiveRequest = {
  id: string;
  subjectId: string;
  purpose: string;
  permitState: null | 'authorized' | 'dispatched' | 'settled' | 'unknown' | 'cancelled';
  upperMicros: number;
};
export type LiveRequests = { turnFence: TurnFence; requests: LiveRequest[] };
export const generationAuthorizationId = (value: LiveTestStatus | null) =>
  value?.authorizationId ?? value?.sessionId ?? null;
export const generationExpired = (value: LiveTestStatus, now = Date.now()) =>
  value.mode === 'owner'
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
  !!generationAuthorizationId(value) &&
  !generationExpired(value, now) &&
  generationPricingCurrent(value, now) &&
  value.remainingMicros > 0;
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

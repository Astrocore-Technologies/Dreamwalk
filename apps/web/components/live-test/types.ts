export type TurnFence = { roundId: string; phaseEpoch: number; rulesetVersion: 1 };
export type LiveTestStatus = {
  enabled: boolean;
  sessionId: string;
  state: 'unclaimed' | 'active' | 'stopped' | 'expired';
  expiresAt: string;
  stopCode?: string | null;
  capMicros: number;
  usedMicros: number;
  heldMicros: number;
  remainingMicros: number;
  priorHeldReservations: number;
  imagesEnabled: boolean;
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
export const liveSessionActive = (value: LiveTestStatus | null, now = Date.now()) =>
  !!value &&
  value.enabled &&
  value.state === 'active' &&
  Date.parse(value.expiresAt) > now &&
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

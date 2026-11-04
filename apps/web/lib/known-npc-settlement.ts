/** Browser recovery is read-only until an explicit confirmation event. */
export type KnownSettlementQuote = {
  jobId: string;
  holdId: string;
  status: 'pending' | 'settled' | 'released';
  actualMicros: string;
  reservedSubunits: string;
  captureSubunits: string;
  releaseSubunits: string;
  rateVersion: string;
  funding: {
    dreamsCaptureSubunits: string;
    dreamsReleaseSubunits: string;
    sparksCaptureSubunits: string;
    sparksReleaseSubunits: string;
  };
  requiresConsent: boolean;
  noGameEffect: true;
};
export type KnownSettlementConsent = {
  operationId: string;
  holdId: string;
  expectedActualMicros: string;
  expectedReservedSubunits: string;
  expectedCaptureSubunits: string;
  consent: true;
};
type StoredAttempt = { version: 1; quote: KnownSettlementQuote; body: KnownSettlementConsent };
export type SettlementState = {
  quote: KnownSettlementQuote | null;
  phase: 'loading' | 'ready' | 'sending' | 'uncertain' | 'complete' | 'error';
  error: 'unavailable' | 'changed' | 'storage' | 'uncertain' | null;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const amount = /^(0|[1-9][0-9]{0,18})$/;
export function settlementScope(ownerId: string, campaignId: string, jobId: string) {
  if (![ownerId, campaignId, jobId].every((id) => uuid.test(id))) throw new Error('unavailable');
  return {
    path: `/game/campaigns/${campaignId}/ai/jobs/${jobId}/settlement`,
    storageKey: `dreamwalk:npc-settlement:v1:${ownerId}:${campaignId}:${jobId}`,
  };
}
export function readKnownSettlement(value: unknown, jobId: string): KnownSettlementQuote {
  const q = value as KnownSettlementQuote | null;
  if (
    !q ||
    q.jobId !== jobId ||
    !uuid.test(q.holdId) ||
    q.noGameEffect !== true ||
    !['pending', 'settled', 'released'].includes(q.status) ||
    q.requiresConsent !== (q.status === 'pending') ||
    !['api-cent-1-spark-v1', 'api-cent-2-sparks-v2'].includes(q.rateVersion) ||
    !q.funding
  )
    throw new Error('unavailable');
  const amounts = [
    q.actualMicros,
    q.reservedSubunits,
    q.captureSubunits,
    q.releaseSubunits,
    q.funding.dreamsCaptureSubunits,
    q.funding.dreamsReleaseSubunits,
    q.funding.sparksCaptureSubunits,
    q.funding.sparksReleaseSubunits,
  ];
  if (
    amounts.some(
      (v) => typeof v !== 'string' || !amount.test(v) || BigInt(v) > 9_223_372_036_854_775_807n,
    ) ||
    BigInt(q.captureSubunits) !==
      BigInt(q.actualMicros) * (q.rateVersion === 'api-cent-2-sparks-v2' ? 2n : 1n) ||
    BigInt(q.captureSubunits) + BigInt(q.releaseSubunits) !== BigInt(q.reservedSubunits) ||
    BigInt(q.funding.dreamsCaptureSubunits) + BigInt(q.funding.sparksCaptureSubunits) !==
      BigInt(q.captureSubunits) ||
    BigInt(q.funding.dreamsReleaseSubunits) + BigInt(q.funding.sparksReleaseSubunits) !==
      BigInt(q.releaseSubunits)
  )
    throw new Error('unavailable');
  // Retain only the public quote contract, never arbitrary response properties.
  return {
    jobId: q.jobId,
    holdId: q.holdId,
    status: q.status,
    actualMicros: q.actualMicros,
    reservedSubunits: q.reservedSubunits,
    captureSubunits: q.captureSubunits,
    releaseSubunits: q.releaseSubunits,
    rateVersion: q.rateVersion,
    funding: {
      dreamsCaptureSubunits: q.funding.dreamsCaptureSubunits,
      dreamsReleaseSubunits: q.funding.dreamsReleaseSubunits,
      sparksCaptureSubunits: q.funding.sparksCaptureSubunits,
      sparksReleaseSubunits: q.funding.sparksReleaseSubunits,
    },
    requiresConsent: q.requiresConsent,
    noGameEffect: true,
  };
}
function matches(a: KnownSettlementQuote, b: KnownSettlementQuote) {
  return (
    a.jobId === b.jobId &&
    a.holdId === b.holdId &&
    a.actualMicros === b.actualMicros &&
    a.reservedSubunits === b.reservedSubunits &&
    a.captureSubunits === b.captureSubunits &&
    a.releaseSubunits === b.releaseSubunits &&
    a.rateVersion === b.rateVersion &&
    Object.entries(a.funding).every(
      ([key, value]) => b.funding[key as keyof typeof b.funding] === value,
    )
  );
}
export class KnownSettlementController {
  private active = true;
  private busy = false;
  private attempt: StoredAttempt | null = null;
  private state: SettlementState = { quote: null, phase: 'loading', error: null };
  private scope: ReturnType<typeof settlementScope>;
  constructor(
    private input: {
      ownerId: string;
      campaignId: string;
      jobId: string;
      storage: Pick<Storage, 'getItem' | 'setItem'>;
      read: (path: string) => Promise<unknown>;
      post: (path: string, body: KnownSettlementConsent) => Promise<unknown>;
      operationId: () => string;
      changed: (state: SettlementState) => void;
    },
  ) {
    this.scope = settlementScope(input.ownerId, input.campaignId, input.jobId);
  }
  private publish(patch: Partial<SettlementState>) {
    if (!this.active) return;
    this.state = { ...this.state, ...patch };
    this.input.changed(this.state);
  }
  private restore() {
    const raw = this.input.storage.getItem(this.scope.storageKey);
    if (!raw) return;
    const stored = JSON.parse(raw) as StoredAttempt;
    if (stored.version !== 1 || !stored.body || !uuid.test(stored.body.operationId))
      throw new Error('storage');
    const quote = readKnownSettlement(stored.quote, this.input.jobId);
    const expected = this.body(quote, stored.body.operationId);
    if (JSON.stringify(expected) !== JSON.stringify(stored.body)) throw new Error('storage');
    this.attempt = { version: 1, quote, body: expected };
  }
  private body(q: KnownSettlementQuote, operationId: string): KnownSettlementConsent {
    return {
      operationId,
      holdId: q.holdId,
      expectedActualMicros: q.actualMicros,
      expectedReservedSubunits: q.reservedSubunits,
      expectedCaptureSubunits: q.captureSubunits,
      consent: true,
    };
  }
  async refresh() {
    if (!this.active || this.busy) return;
    this.busy = true;
    this.publish({ phase: 'loading', error: null });
    try {
      const quote = readKnownSettlement(await this.input.read(this.scope.path), this.input.jobId);
      if (!this.active) return;
      this.publish({ quote });
      if (quote.status !== 'pending') {
        this.publish({ phase: 'complete' });
        return;
      }
      try {
        this.restore();
      } catch {
        throw new Error('storage');
      }
      if (this.attempt && !matches(this.attempt.quote, quote)) throw new Error('changed');
      this.publish({
        phase: this.attempt ? 'uncertain' : 'ready',
        error: this.attempt ? 'uncertain' : null,
      });
    } catch (err) {
      const code =
        err instanceof Error && ['storage', 'changed'].includes(err.message)
          ? (err.message as 'storage' | 'changed')
          : 'unavailable';
      this.publish({ phase: 'error', error: code });
    } finally {
      this.busy = false;
    }
  }
  /** Only call from the owner's confirmation button, never from mount/poll/recovery. */
  async confirm() {
    if (
      !this.active ||
      this.busy ||
      !this.state.quote ||
      !['ready', 'uncertain'].includes(this.state.phase)
    )
      return;
    this.busy = true;
    const shown = this.state.quote;
    this.publish({ phase: 'sending', error: null });
    let sent = false;
    try {
      const fresh = readKnownSettlement(await this.input.read(this.scope.path), this.input.jobId);
      if (!this.active) return;
      if (fresh.status !== 'pending') {
        this.publish({ quote: fresh, phase: 'complete' });
        return;
      }
      if (!matches(shown, fresh) || (this.attempt && !matches(this.attempt.quote, fresh)))
        throw new Error('changed');
      if (!this.attempt) {
        const operationId = this.input.operationId();
        if (!uuid.test(operationId)) throw new Error('storage');
        this.attempt = { version: 1, quote: fresh, body: this.body(fresh, operationId) };
      }
      // Write before sending. An interrupted response or reload must not create a different receipt.
      try {
        this.input.storage.setItem(this.scope.storageKey, JSON.stringify(this.attempt));
      } catch {
        throw new Error('storage');
      }
      sent = true;
      const result = readKnownSettlement(
        await this.input.post(this.scope.path, this.attempt.body),
        this.input.jobId,
      );
      if (!matches(fresh, result) || result.status === 'pending') throw new Error('uncertain');
      this.publish({ quote: result, phase: 'complete' });
    } catch (err) {
      const code = sent
        ? 'uncertain'
        : err instanceof Error && ['storage', 'changed'].includes(err.message)
          ? (err.message as 'storage' | 'changed')
          : 'unavailable';
      this.publish({ phase: sent ? 'uncertain' : 'error', error: code });
    } finally {
      this.busy = false;
    }
  }
  dispose() {
    this.active = false;
  }
}

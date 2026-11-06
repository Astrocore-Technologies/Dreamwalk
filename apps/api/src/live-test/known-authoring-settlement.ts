import {
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { z } from 'zod';
import { parseSparkInteger, providerMicrosToSparkSubunits } from '@dreamwalk/contracts';
import { Db } from '../db';
import { fail } from '../errors';
import { digest } from '../ai/context';
import { GenerationAuthority } from '../generation/service';
import { fenceGenerationAdmission } from '../generation/scope-fence';
import {
  SparksAccounting,
  DREAMS_FIRST_POLICY,
  planSparkSettlement,
  sparkQuoteRateVersion,
  type SparkHold,
} from '../generation/sparks-accounting';
import { planDreamSettlement, type DreamHold } from '../generation/dreams-accounting';
import { textUsageCostMicros } from '../generation/text-pricing';

const amount = z.string().regex(/^(0|[1-9][0-9]{0,15})$/);
const consentSchema = z
  .object({
    operationId: z.uuid(),
    holdId: z.uuid(),
    expectedActualMicros: amount,
    expectedReservedSubunits: amount,
    expectedCaptureSubunits: amount,
    consent: z.literal(true),
  })
  .strict();
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const usageSchema = z.object({
  inputTokens: integer,
  outputTokens: integer,
  cachedInputTokens: integer.optional(),
  cacheWriteInputTokens: integer.optional(),
  cacheWriteInputTokensDetails: z
    .object({ ttl30mTokens: integer, ttl12hTokens: integer })
    .optional(),
  costMicros: integer,
  costEvidence: z.literal('configured_rates'),
  costVerifiedForSparks: z.literal(true),
});
const pricingSchema = z.object({
  model: z.string().min(1),
  inputMicrosPerMillion: integer,
  outputMicrosPerMillion: integer,
  cachePricing: z
    .object({
      cachedInputMicrosPerMillion: integer,
      cacheWrite30mMicrosPerMillion: integer,
      cacheWrite12hMicrosPerMillion: integer,
    })
    .optional(),
  reserveMicros: integer.positive(),
});
function unavailable(): never {
  return fail(409, 'AUTHORING_SETTLEMENT_UNAVAILABLE', 'AUTHORING_SETTLEMENT_UNAVAILABLE');
}
const receipt = (operationId: string, actualMicros: string) => ({
  outcome: 'success' as const,
  actualMicros,
  evidence: 'configured_rates' as const,
  receiptId: `owner-authoring-settlement:${operationId}`,
});

/** Original authoring admission and known usage only. Never infer cost from today's tariff. */
/** originalTerminalReceipt validates the original success receipt in read-only proofs. */
export function knownAuthoringSettlementQuote(
  job: QueryResultRow,
  native: QueryResultRow,
  authorization: QueryResultRow,
  reservation: QueryResultRow,
  hold: QueryResultRow,
  quote: QueryResultRow,
  previous?: QueryResultRow,
  dreams?: { hold: QueryResultRow; quote: QueryResultRow },
  automatic = false,
  originalTerminalReceipt = false,
) {
  const admitted = quote.price_snapshot?.providerQuote;
  const legacyConsentHash = digest({
    quoteId: native.id,
    operationId: job.operation_id,
    consent: true,
  });
  const policyConsentHash =
    admitted?.automaticKnownCostPolicy === 'known-cost-v1'
      ? digest({
          quoteId: native.id,
          operationId: job.operation_id,
          consent: true,
          automaticKnownCostPolicy: 'known-cost-v1',
        })
      : undefined;
  if (
    !(
      originalTerminalReceipt
        ? ['committed', 'stale', 'failed', 'cancelled']
        : automatic
          ? ['stale', 'failed', 'cancelled']
          : ['stale', 'failed']
    ).includes(job.status) ||
    !job.dispatched_at ||
    !job.completed_at ||
    job.context_hash === 'erased' ||
    job.error_code === 'DATA_ERASED' ||
    job.spark_cost_evidence !== 'configured_rates' ||
    job.quote_id !== native.id ||
    job.actor_id !== native.actor_id ||
    job.session_id !== native.session_id ||
    job.project_id !== native.project_id ||
    !job.project_id ||
    [
      'project_revision',
      'source_hash',
      'readset_hash',
      'context_hash',
      'provider_version',
      'generation_policy_revision',
      'generation_policy_hash',
    ].some((key) => job[key] !== native[key]) ||
    (automatic
      ? !policyConsentHash || job.request_hash !== policyConsentHash
      : job.request_hash !== legacyConsentHash &&
        (!policyConsentHash || job.request_hash !== policyConsentHash)) ||
    authorization.id !== job.session_id ||
    authorization.mode !== 'release' ||
    authorization.owner_id !== job.actor_id ||
    authorization.scope_id !== `release:${job.actor_id}` ||
    reservation.id !== job.reservation_id ||
    reservation.actor_id !== job.actor_id ||
    reservation.scope_id !== authorization.scope_id ||
    reservation.kind !== 'text' ||
    reservation.operation_key !== `manual-authoring-text:${job.id}` ||
    reservation.status !== 'settled' ||
    String(reservation.actual_micros) !== String(job.actual_micros) ||
    reservation.spark_quote_id !== job.spark_quote_id ||
    native.spark_quote_id !== job.spark_quote_id ||
    job.spark_quote_id !== hold.id ||
    quote.id !== hold.id ||
    hold.owner_id !== job.actor_id ||
    quote.owner_id !== job.actor_id ||
    hold.source_kind !== 'text' ||
    quote.source_kind !== 'text' ||
    hold.source_id !== native.id ||
    quote.source_id !== native.id ||
    quote.operation_id !== native.id ||
    String(quote.reserve_subunits) !== String(hold.reserved_subunits) ||
    !(
      (hold.status === 'pending' &&
        (hold.reason === 'failure_policy_pending' || (automatic && hold.reason === 'unknown')) &&
        hold.captured_subunits === null &&
        hold.settlement_fingerprint === null) ||
      (['settled', 'released'].includes(hold.status) && hold.reason === null)
    ) ||
    !job.request_snapshot ||
    !native.request_snapshot ||
    !admitted ||
    (admitted.automaticKnownCostPolicy !== undefined &&
      admitted.automaticKnownCostPolicy !== 'known-cost-v1') ||
    !admitted.requestSnapshot ||
    digest(job.request_snapshot) !== digest(native.request_snapshot) ||
    digest(job.request_snapshot) !== digest(admitted.requestSnapshot) ||
    admitted.quoteId !== native.id ||
    admitted.providerVersion !== job.provider_version ||
    admitted.requestHash !== native.request_hash
  )
    unavailable();
  const usage = usageSchema.safeParse(job.provider_usage);
  const pricing = pricingSchema.safeParse(job.request_snapshot);
  if (!usage.success || !pricing.success) unavailable();
  const tariff = quote.price_snapshot?.tariff;
  const p = pricing.data;
  if (
    !tariff ||
    tariff.providerRateVersion !== job.provider_version ||
    tariff.model !== p.model ||
    tariff.inputMicrosPerMillion !== String(p.inputMicrosPerMillion) ||
    tariff.outputMicrosPerMillion !== String(p.outputMicrosPerMillion) ||
    tariff.cachedInputMicrosPerMillion !==
      String(p.cachePricing?.cachedInputMicrosPerMillion ?? p.inputMicrosPerMillion) ||
    (p.cachePricing &&
      tariff.cacheWriteMicrosPerMillion !== String(p.cachePricing.cacheWrite30mMicrosPerMillion)) ||
    String(reservation.upper_micros) !== String(p.reserveMicros) ||
    String(native.upper_micros) !== String(p.reserveMicros)
  )
    unavailable();
  try {
    const cost = textUsageCostMicros(p, usage.data);
    const actualMicros = String(cost.costMicros);
    const rateVersion = sparkQuoteRateVersion(quote.price_snapshot);
    const captureSubunits = providerMicrosToSparkSubunits(actualMicros, rateVersion);
    const reserve = parseSparkInteger(String(hold.reserved_subunits));
    const sparkReserve = parseSparkInteger(
      String(hold.sparks_reserved_subunits ?? hold.reserved_subunits),
    );
    if (
      !cost.costVerifiedForSparks ||
      cost.costMicros !== usage.data.costMicros ||
      cost.costMicros > p.reserveMicros ||
      actualMicros !== String(job.actual_micros) ||
      BigInt(captureSubunits) > reserve ||
      reserve !== BigInt(providerMicrosToSparkSubunits(String(p.reserveMicros), rateVersion)) ||
      sparkReserve > reserve ||
      !!hold.dream_hold_id !== sparkReserve < reserve
    )
      unavailable();
    const capture = BigInt(captureSubunits),
      releaseSubunits = (reserve - capture).toString();
    if (hold.status !== 'pending') {
      const details = originalTerminalReceipt
        ? {
            operationId: job.operation_id,
            holdId: hold.id,
            actualMicros,
            captureSubunits,
            releaseSubunits,
          }
        : previous?.details;
      if (
        !details ||
        !z.uuid().safeParse(details.operationId).success ||
        details.holdId !== hold.id ||
        details.actualMicros !== actualMicros ||
        details.captureSubunits !== captureSubunits ||
        details.releaseSubunits !== releaseSubunits ||
        String(hold.captured_subunits) !== captureSubunits ||
        hold.status !== (capture === 0n ? 'released' : 'settled') ||
        !planSparkSettlement(
          { ...hold, spark_rate_version: rateVersion } as SparkHold,
          originalTerminalReceipt
            ? {
                outcome: 'success',
                actualMicros,
                evidence: 'configured_rates',
                receiptId: `authoring:${job.id}`,
              }
            : receipt(details.operationId, actualMicros),
          true,
        ).duplicate
      )
        unavailable();
    } else if (previous) unavailable();
    const dreamReserve = reserve - sparkReserve;
    const dreamCapture = capture < dreamReserve ? capture : dreamReserve;
    if (dreamReserve > 0n) {
      const dh = dreams?.hold,
        dq = dreams?.quote;
      if (
        !dh ||
        !dq ||
        quote.price_snapshot.fundingPolicy !== DREAMS_FIRST_POLICY ||
        dh.id !== hold.dream_hold_id ||
        dq.id !== dh.id ||
        dh.owner_id !== job.actor_id ||
        dq.owner_id !== job.actor_id ||
        dh.source_kind !== 'text' ||
        dq.source_kind !== 'text' ||
        dh.source_id !== native.id ||
        dq.source_id !== native.id ||
        dq.operation_id !== hold.id ||
        String(dh.reserved_subunits) !== dreamReserve.toString() ||
        String(dq.reserve_subunits) !== dreamReserve.toString() ||
        dq.price_snapshot?.currency !== 'dreams' ||
        dq.price_snapshot?.policyVersion !== DREAMS_FIRST_POLICY ||
        dq.price_snapshot?.providerQuote?.sparkQuoteId !== hold.id ||
        !dq.price_snapshot?.providerQuote?.priceSnapshot ||
        digest(dq.price_snapshot.providerQuote.priceSnapshot) !== digest(quote.price_snapshot)
      )
        unavailable();
      if (hold.status === 'pending') {
        if (
          dh.status !== 'pending' ||
          dh.reason !== 'unknown' ||
          dh.captured_subunits !== null ||
          dh.settlement_fingerprint !== null
        )
          unavailable();
      } else if (
        dh.status !== (dreamCapture === 0n ? 'released' : 'settled') ||
        dh.reason !== null ||
        String(dh.captured_subunits) !== dreamCapture.toString() ||
        !planDreamSettlement(
          { ...dh, policy_version: DREAMS_FIRST_POLICY } as DreamHold,
          {
            outcome: 'success',
            actualSubunits: dreamCapture.toString(),
            policyVersion: DREAMS_FIRST_POLICY,
            evidence: 'configured_rates',
            receiptId: originalTerminalReceipt
              ? `authoring:${job.id}`
              : receipt(previous!.details.operationId, actualMicros).receiptId,
          },
          true,
        ).duplicate
      )
        unavailable();
    } else if (dreams) unavailable();
    return {
      jobId: String(job.id),
      holdId: String(hold.id),
      status: String(hold.status),
      actualMicros,
      reservedSubunits: reserve.toString(),
      captureSubunits,
      releaseSubunits,
      rateVersion,
      funding: {
        dreamsCaptureSubunits: dreamCapture.toString(),
        dreamsReleaseSubunits: (reserve - sparkReserve - dreamCapture).toString(),
        sparksCaptureSubunits: (capture - dreamCapture).toString(),
        sparksReleaseSubunits: (sparkReserve - (capture - dreamCapture)).toString(),
      },
      // Only the immutable quote and its matching original acceptance authorize automatic recovery.
      settlementMode:
        policyConsentHash && job.request_hash === policyConsentHash
          ? ('automatic' as const)
          : ('legacy_confirmation' as const),
      requiresConsent: hold.status === 'pending',
      noGameEffect: true as const,
      noAuthoringEffect: true as const,
    };
  } catch {
    return unavailable();
  }
}

/** Exact admitted receipt only; no provider access, grants or dispatch capability. */
@Injectable()
export class KnownAuthoringSettlement implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private recovering?: Promise<void>;
  private recoveryCursor: string | null = null;
  private readonly logger = new Logger(KnownAuthoringSettlement.name);
  onModuleInit() {
    void this.recoverPending();
    this.timer = setInterval(() => {
      void this.recoverPending();
    }, 30000);
    this.timer.unref();
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.recovering;
  }
  /** Bounded restart recovery, independent of UI/GETs. Cursor prevents a malformed
   * early receipt from starving later jobs. Every row is reproved under locks. */
  async recoverPending() {
    if (this.recovering) return this.recovering;
    this.recovering = this.recoverPage().catch(() => {
      this.logger.warn('AUTHORING_AUTOMATIC_SETTLEMENT_RECOVERY_FAILED');
    });
    try {
      await this.recovering;
    } finally {
      this.recovering = undefined;
    }
  }
  private async recoverPage() {
    const rows = await this.db.query<{ id: string; actor_id: string }>(
      `
      SELECT j.id,j.actor_id FROM live_authoring_text_jobs j
      JOIN live_test_sessions s ON s.id=j.session_id
      JOIN spark_holds h ON h.id=j.spark_quote_id
      JOIN spark_quotes q ON q.id=h.id
      WHERE q.price_snapshot->'providerQuote'->>'automaticKnownCostPolicy'='known-cost-v1'
        AND s.mode='release' AND j.status IN ('failed','stale','cancelled')
        AND j.actual_micros IS NOT NULL AND j.provider_usage IS NOT NULL
        AND j.spark_cost_evidence='configured_rates'
        AND h.status='pending' AND h.reason IN ('failure_policy_pending','unknown')
        AND ($1::uuid IS NULL OR j.id>$1::uuid)
      ORDER BY j.id LIMIT 25`,
      [this.recoveryCursor],
    );
    for (const row of rows) {
      try {
        await this.db.tx((c) => this.settleAutomatic(c, row.actor_id, row.id));
      } catch {
        this.logger.warn('AUTHORING_AUTOMATIC_SETTLEMENT_JOB_FAILED');
      }
      this.recoveryCursor = row.id;
    }
    if (rows.length < 25) this.recoveryCursor = null;
  }
  constructor(
    @Inject(Db) private db: Db,
    @Inject(GenerationAuthority) private authority: GenerationAuthority,
  ) {}
  /** Called only by a mutation/recovery worker, within its transaction. The original
   * admitted request is the authority; this cannot authorize new provider work. */
  async settleAutomatic(c: PoolClient, ownerId: string, jobId: string) {
    return this.execute(c, ownerId, jobId, undefined, true);
  }
  async handle(ownerId: string, jobId: string, input?: unknown) {
    return this.db.tx((c) => this.execute(c, ownerId, jobId, input));
  }
  private async execute(
    c: PoolClient,
    ownerId: string,
    jobId: string,
    input?: unknown,
    automatic = false,
  ) {
    z.uuid().parse(ownerId);
    z.uuid().parse(jobId);
    let consent = input === undefined ? undefined : consentSchema.parse(input);
    const mutate = automatic || !!consent;
    const peek = (
      await c.query('SELECT session_id FROM live_authoring_text_jobs WHERE id=$1 AND actor_id=$2', [
        jobId,
        ownerId,
      ])
    ).rows[0];
    if (!peek) fail(404, 'NOT_FOUND', 'NOT_FOUND');
    // Match normal settlement lock order: authorization/scope, job, admission fence, wallet.
    const authorization = mutate
      ? await this.authority.lockAuthorization(c, peek.session_id)
      : (
          await c.query('SELECT id,owner_id,scope_id,mode FROM live_test_sessions WHERE id=$1', [
            peek.session_id,
          ])
        ).rows[0];
    const job = (
      await c.query(
        `SELECT * FROM live_authoring_text_jobs WHERE id=$1 AND actor_id=$2${mutate ? ' FOR UPDATE' : ''}`,
        [jobId, ownerId],
      )
    ).rows[0];
    if (!job) fail(404, 'NOT_FOUND', 'NOT_FOUND');
    if (automatic && !['failed', 'stale', 'cancelled'].includes(job.status)) return;
    const native = (
      await c.query('SELECT * FROM live_authoring_text_quotes WHERE id=$1 AND actor_id=$2', [
        job.quote_id,
        ownerId,
      ])
    ).rows[0];
    const reservation = (
      await c.query('SELECT * FROM generation_budget_reservations WHERE id=$1', [
        job.reservation_id,
      ])
    ).rows[0];
    if (!authorization || !native || !reservation) {
      if (automatic) return;
      unavailable();
    }
    if (mutate) {
      await fenceGenerationAdmission(c);
      await c.query('SELECT owner_id FROM spark_wallets WHERE owner_id=$1 FOR UPDATE', [ownerId]);
    }
    const hold = (
      await c.query(
        `SELECT * FROM spark_holds WHERE id=$1 AND owner_id=$2${mutate ? ' FOR UPDATE' : ''}`,
        [job.spark_quote_id, ownerId],
      )
    ).rows[0];
    const quote = (
      await c.query('SELECT * FROM spark_quotes WHERE id=$1 AND owner_id=$2', [
        job.spark_quote_id,
        ownerId,
      ])
    ).rows[0];
    const readDreams = async () => {
      if (!hold?.dream_hold_id) return undefined;
      const dh = (
        await c.query(
          `SELECT * FROM dream_holds WHERE id=$1 AND owner_id=$2${mutate ? ' FOR UPDATE' : ''}`,
          [hold.dream_hold_id, ownerId],
        )
      ).rows[0];
      const dq = (
        await c.query('SELECT * FROM dream_quotes WHERE id=$1 AND owner_id=$2', [
          hold.dream_hold_id,
          ownerId,
        ])
      ).rows[0];
      if (!dh || !dq) {
        if (automatic) return undefined;
        unavailable();
      }
      return { hold: dh, quote: dq };
    };
    // Same split-funding order as SparksAccounting: Sparks wallet/hold, Dreams wallet/hold.
    if (mutate && hold?.dream_hold_id)
      await c.query('SELECT owner_id FROM dream_wallets WHERE owner_id=$1 FOR UPDATE', [ownerId]);
    const dreams = await readDreams();
    const audits = (
      await c.query(
        "SELECT details FROM audit WHERE actor_id=$1 AND target_id=$2 AND action='authoring.known_failure.settled'",
        [ownerId, jobId],
      )
    ).rows;
    if (!hold || !quote || audits.length > 1) {
      if (automatic) return;
      unavailable();
    }
    let view;
    try {
      view = knownAuthoringSettlementQuote(
        job,
        native,
        authorization,
        reservation,
        hold,
        quote,
        audits[0],
        dreams,
        automatic,
      );
    } catch (error) {
      // Only an unavailable proof is a safe no-op. Database/accounting failures
      // must propagate so the encompassing failure transaction rolls back.
      const code = (error as { getResponse?: () => { code?: string } }).getResponse?.()?.code;
      if (automatic && code === 'AUTHORING_SETTLEMENT_UNAVAILABLE') return;
      throw error;
    }
    if (automatic)
      consent = {
        operationId: audits[0]?.details?.operationId ?? job.operation_id,
        holdId: view.holdId,
        expectedActualMicros: view.actualMicros,
        expectedReservedSubunits: view.reservedSubunits,
        expectedCaptureSubunits: view.captureSubunits,
        consent: true,
      };
    if (!consent) return view;
    // New requests already authorize the recovery worker. Manual confirmation is
    // only for older generic admissions, never a second route for pending automatic work.
    if (!automatic && view.status === 'pending' && view.settlementMode !== 'legacy_confirmation')
      unavailable();
    if (
      consent.holdId !== view.holdId ||
      consent.expectedActualMicros !== view.actualMicros ||
      consent.expectedReservedSubunits !== view.reservedSubunits ||
      consent.expectedCaptureSubunits !== view.captureSubunits
    )
      fail(409, 'AUTHORING_SETTLEMENT_CHANGED', 'AUTHORING_SETTLEMENT_CHANGED');
    let settled;
    try {
      settled = await new SparksAccounting().settle(
        c,
        ownerId,
        hold.id,
        receipt(consent.operationId, view.actualMicros),
        true,
      );
    } catch (error) {
      if (error instanceof Error && /^SPARK_[A-Z_]+$/.test(error.message))
        fail(409, error.message, error.message);
      throw error;
    }
    const details = {
      operationId: consent.operationId,
      holdId: hold.id,
      actualMicros: view.actualMicros,
      captureSubunits: view.captureSubunits,
      releaseSubunits: view.releaseSubunits,
    };
    // Accounting must terminalize both exact holds. Any nested pending/conflict rolls back all writes.
    const finalView = knownAuthoringSettlementQuote(
      job,
      native,
      authorization,
      reservation,
      settled,
      quote,
      { details },
      await readDreams(),
      automatic,
    );
    if (finalView.requiresConsent) unavailable();
    if (hold.status === 'pending')
      await c.query('INSERT INTO audit(actor_id,action,target_id,details) VALUES($1,$2,$3,$4)', [
        ownerId,
        'authoring.known_failure.settled',
        jobId,
        JSON.stringify(details),
      ]);
    return finalView;
  }
}

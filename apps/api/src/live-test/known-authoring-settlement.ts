import { Inject, Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
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
export function knownAuthoringSettlementQuote(
  job: QueryResultRow,
  native: QueryResultRow,
  authorization: QueryResultRow,
  reservation: QueryResultRow,
  hold: QueryResultRow,
  quote: QueryResultRow,
  previous?: QueryResultRow,
  dreams?: { hold: QueryResultRow; quote: QueryResultRow },
) {
  const admitted = quote.price_snapshot?.providerQuote;
  if (
    !['stale', 'failed'].includes(job.status) ||
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
    job.request_hash !==
      digest({ quoteId: native.id, operationId: job.operation_id, consent: true }) ||
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
        hold.reason === 'failure_policy_pending' &&
        hold.captured_subunits === null &&
        hold.settlement_fingerprint === null) ||
      (['settled', 'released'].includes(hold.status) && hold.reason === null)
    ) ||
    !job.request_snapshot ||
    !native.request_snapshot ||
    !admitted ||
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
      const details = previous?.details;
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
          receipt(details.operationId, actualMicros),
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
            receiptId: receipt(previous!.details.operationId, actualMicros).receiptId,
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
      requiresConsent: hold.status === 'pending',
      noGameEffect: true as const,
      noAuthoringEffect: true as const,
    };
  } catch {
    return unavailable();
  }
}

/** Explicit owner receipt only; no provider access, historical edits, grants or dispatch capability. */
@Injectable()
export class KnownAuthoringSettlement {
  constructor(
    @Inject(Db) private db: Db,
    @Inject(GenerationAuthority) private authority: GenerationAuthority,
  ) {}
  async handle(ownerId: string, jobId: string, input?: unknown) {
    z.uuid().parse(ownerId);
    z.uuid().parse(jobId);
    const consent = input === undefined ? undefined : consentSchema.parse(input);
    return this.db.tx(async (c) => {
      const peek = (
        await c.query(
          'SELECT session_id FROM live_authoring_text_jobs WHERE id=$1 AND actor_id=$2',
          [jobId, ownerId],
        )
      ).rows[0];
      if (!peek) fail(404, 'NOT_FOUND', 'NOT_FOUND');
      // Match normal settlement lock order: authorization/scope, job, admission fence, wallet.
      const authorization = consent
        ? await this.authority.lockAuthorization(c, peek.session_id)
        : (
            await c.query('SELECT id,owner_id,scope_id,mode FROM live_test_sessions WHERE id=$1', [
              peek.session_id,
            ])
          ).rows[0];
      const job = (
        await c.query(
          `SELECT * FROM live_authoring_text_jobs WHERE id=$1 AND actor_id=$2${consent ? ' FOR UPDATE' : ''}`,
          [jobId, ownerId],
        )
      ).rows[0];
      if (!job) fail(404, 'NOT_FOUND', 'NOT_FOUND');
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
      if (!authorization || !native || !reservation) unavailable();
      if (consent) {
        await fenceGenerationAdmission(c);
        await c.query('SELECT owner_id FROM spark_wallets WHERE owner_id=$1 FOR UPDATE', [ownerId]);
      }
      const hold = (
        await c.query(
          `SELECT * FROM spark_holds WHERE id=$1 AND owner_id=$2${consent ? ' FOR UPDATE' : ''}`,
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
            `SELECT * FROM dream_holds WHERE id=$1 AND owner_id=$2${consent ? ' FOR UPDATE' : ''}`,
            [hold.dream_hold_id, ownerId],
          )
        ).rows[0];
        const dq = (
          await c.query('SELECT * FROM dream_quotes WHERE id=$1 AND owner_id=$2', [
            hold.dream_hold_id,
            ownerId,
          ])
        ).rows[0];
        if (!dh || !dq) unavailable();
        return { hold: dh, quote: dq };
      };
      // Same split-funding order as SparksAccounting: Sparks wallet/hold, Dreams wallet/hold.
      if (consent && hold?.dream_hold_id)
        await c.query('SELECT owner_id FROM dream_wallets WHERE owner_id=$1 FOR UPDATE', [ownerId]);
      const dreams = await readDreams();
      const audits = (
        await c.query(
          "SELECT details FROM audit WHERE actor_id=$1 AND target_id=$2 AND action='authoring.known_failure.settled'",
          [ownerId, jobId],
        )
      ).rows;
      if (!hold || !quote || audits.length > 1) unavailable();
      const view = knownAuthoringSettlementQuote(
        job,
        native,
        authorization,
        reservation,
        hold,
        quote,
        audits[0],
        dreams,
      );
      if (!consent) return view;
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
    });
  }
}

import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient, QueryResultRow } from 'pg';
import { z } from 'zod';
import { providerMicrosToSparkSubunits } from '@dreamwalk/contracts';
import { Auth } from '../auth';
import { Db } from '../db';
import { fail } from '../errors';
import { digest } from '../ai/context';
import { GenerationAuthority } from '../generation/service';
import { fenceGenerationAdmission } from '../generation/scope-fence';
import { SparksAccounting, sparkQuoteRateVersion } from '../generation/sparks-accounting';
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
const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  cacheWriteInputTokens: z.number().int().nonnegative().optional(),
  cacheWriteInputTokensDetails: z
    .object({
      ttl30mTokens: z.number().int().nonnegative(),
      ttl12hTokens: z.number().int().nonnegative(),
    })
    .optional(),
  costMicros: z.number().int().nonnegative(),
  costEvidence: z.literal('configured_rates'),
  costVerifiedForSparks: z.literal(true),
});
const pricingSchema = z.object({
  inputMicrosPerMillion: z.number().int().nonnegative(),
  outputMicrosPerMillion: z.number().int().nonnegative(),
  cachePricing: z
    .object({
      cachedInputMicrosPerMillion: z.number().int().nonnegative(),
      cacheWrite30mMicrosPerMillion: z.number().int().nonnegative(),
      cacheWrite12hMicrosPerMillion: z.number().int().nonnegative(),
    })
    .optional(),
});
function unavailable(): never {
  return fail(409, 'NPC_SETTLEMENT_UNAVAILABLE', 'NPC_SETTLEMENT_UNAVAILABLE');
}

/** Pure, fail-closed proof. No provider, prose, current tariff or campaign state is consulted. */
export function knownNpcSettlementQuote(
  job: QueryResultRow,
  hold: QueryResultRow,
  quote: QueryResultRow,
) {
  if (
    !['stale', 'failed'].includes(job.status) ||
    job.provider_budget_status !== 'spent' ||
    job.provider_external !== true ||
    job.provider_cost_evidence !== 'configured_rates' ||
    job.subject_kind !== 'npc' ||
    job.credits !== 0 ||
    job.sponsor_id ||
    !job.provider_id?.startsWith('release:') ||
    job.spark_hold_id !== hold.id ||
    job.payer_user_id !== hold.owner_id ||
    job.requester_user_id !== hold.owner_id ||
    quote.id !== hold.id ||
    quote.owner_id !== hold.owner_id ||
    quote.source_kind !== 'npc' ||
    quote.source_id !== job.quote_id ||
    hold.source_kind !== 'npc' ||
    hold.source_id !== job.quote_id ||
    String(quote.reserve_subunits) !== String(hold.reserved_subunits) ||
    !(
      (hold.status === 'pending' && hold.reason === 'failure_policy_pending') ||
      ['settled', 'released'].includes(hold.status)
    )
  )
    unavailable();
  const usage = usageSchema.safeParse(job.provider_usage);
  const pricing = pricingSchema.safeParse(job.request_snapshot);
  const admitted = quote.price_snapshot?.providerQuote;
  if (!usage.success || !pricing.success || !admitted || !job.request_snapshot) unavailable();
  if (
    Object.entries(job.request_snapshot).some(
      ([key, value]) => admitted[key] === undefined || digest(admitted[key]) !== digest(value),
    )
  )
    unavailable();
  let actual: number;
  let rateVersion: ReturnType<typeof sparkQuoteRateVersion>;
  let capture: string;
  try {
    const cost = textUsageCostMicros(pricing.data, usage.data);
    if (!cost.costVerifiedForSparks) unavailable();
    actual = cost.costMicros;
    rateVersion = sparkQuoteRateVersion(quote.price_snapshot);
    capture = providerMicrosToSparkSubunits(String(actual), rateVersion);
  } catch {
    return unavailable();
  }
  if (
    String(actual) !== String(job.provider_actual_micros) ||
    actual !== usage.data.costMicros ||
    String(job.input_tokens) !== String(usage.data.inputTokens) ||
    String(job.output_tokens) !== String(usage.data.outputTokens) ||
    String(job.cached_input_tokens ?? 0) !== String(usage.data.cachedInputTokens ?? 0) ||
    BigInt(capture) > BigInt(hold.reserved_subunits)
  )
    unavailable();
  const reserve = BigInt(hold.reserved_subunits);
  const sparkReserve = BigInt(hold.sparks_reserved_subunits ?? hold.reserved_subunits);
  if (
    sparkReserve > reserve ||
    sparkReserve < 0n ||
    !!hold.dream_hold_id !== sparkReserve < reserve
  )
    unavailable();
  const dreamCapture =
    BigInt(capture) < reserve - sparkReserve ? BigInt(capture) : reserve - sparkReserve;
  return {
    jobId: String(job.id),
    holdId: String(hold.id),
    status: String(hold.status),
    actualMicros: String(actual),
    reservedSubunits: reserve.toString(),
    captureSubunits: capture,
    releaseSubunits: (reserve - BigInt(capture)).toString(),
    rateVersion,
    funding: {
      dreamsCaptureSubunits: dreamCapture.toString(),
      dreamsReleaseSubunits: (reserve - sparkReserve - dreamCapture).toString(),
      sparksCaptureSubunits: (BigInt(capture) - dreamCapture).toString(),
      sparksReleaseSubunits: (sparkReserve - (BigInt(capture) - dreamCapture)).toString(),
    },
    requiresConsent: hold.status === 'pending',
    noGameEffect: true as const,
  };
}

/** Owner-confirmed settlement of a known bill, never provider retry or permission to dispatch. */
@Injectable()
export class KnownNpcSettlement {
  constructor(
    @Inject(Db) private db: Db,
    @Inject(Auth) private auth: Auth,
    @Inject(GenerationAuthority) private authority: GenerationAuthority,
  ) {}
  async handle(req: Request, campaignId: string, jobId: string, input?: unknown) {
    const owner = await this.auth.require(req);
    z.uuid().parse(campaignId);
    z.uuid().parse(jobId);
    const consent = input === undefined ? undefined : consentSchema.parse(input);
    return this.db.tx(async (c) => {
      const campaign = (
        await c.query(
          `SELECT id,owner_id FROM game_campaigns WHERE id=$1${consent ? ' FOR UPDATE' : ''}`,
          [campaignId],
        )
      ).rows[0];
      if (!campaign || campaign.owner_id !== owner.id) fail(404, 'NOT_FOUND', 'NOT_FOUND');
      const job = (
        await c.query(
          `SELECT id,campaign_id,quote_id,payer_user_id,requester_user_id,subject_kind,credits,sponsor_id,
          status,provider_id,provider_external,provider_budget_status,provider_actual_micros,
          provider_cost_evidence,provider_usage,request_snapshot,input_tokens,output_tokens,cached_input_tokens,
          spark_hold_id,generation_authorization_id,generation_reservation_id
         FROM npc_ai_jobs WHERE id=$1 AND campaign_id=$2${consent ? ' FOR UPDATE' : ''}`,
          [jobId, campaignId],
        )
      ).rows[0];
      if (!job || job.payer_user_id !== owner.id) fail(404, 'NOT_FOUND', 'NOT_FOUND');
      if (!job.generation_authorization_id || !job.generation_reservation_id) unavailable();
      if (
        consent &&
        !(
          await c.query(
            'SELECT provider_id FROM npc_ai_provider_budgets WHERE provider_id=$1 FOR UPDATE',
            [job.provider_id],
          )
        ).rowCount
      )
        unavailable();
      const authorization = consent
        ? await this.authority.lockAuthorization(c, job.generation_authorization_id)
        : (
            await c.query('SELECT owner_id,scope_id,mode FROM live_test_sessions WHERE id=$1', [
              job.generation_authorization_id,
            ])
          ).rows[0];
      const reservation = (
        await c.query(
          'SELECT actor_id,scope_id,spark_quote_id,status,actual_micros,kind FROM generation_budget_reservations WHERE id=$1',
          [job.generation_reservation_id],
        )
      ).rows[0];
      if (
        !authorization ||
        authorization.mode !== 'release' ||
        authorization.owner_id !== owner.id ||
        !reservation ||
        reservation.actor_id !== owner.id ||
        reservation.scope_id !== authorization.scope_id ||
        reservation.scope_id !== `release:${owner.id}` ||
        reservation.spark_quote_id !== job.spark_hold_id ||
        reservation.kind !== 'text' ||
        reservation.status !== 'settled' ||
        String(reservation.actual_micros) !== String(job.provider_actual_micros)
      )
        unavailable();
      if (consent) {
        await fenceGenerationAdmission(c);
        await c.query('SELECT owner_id FROM spark_wallets WHERE owner_id=$1 FOR UPDATE', [
          owner.id,
        ]);
      }
      const hold = (
        await c.query(
          `SELECT * FROM spark_holds WHERE id=$1 AND owner_id=$2${consent ? ' FOR UPDATE' : ''}`,
          [job.spark_hold_id, owner.id],
        )
      ).rows[0];
      const quote = (
        await c.query('SELECT * FROM spark_quotes WHERE id=$1 AND owner_id=$2', [
          job.spark_hold_id,
          owner.id,
        ])
      ).rows[0];
      if (!hold || !quote) unavailable();
      const view = knownNpcSettlementQuote(job, hold, quote);
      if (!consent) return view;
      if (
        consent.holdId !== view.holdId ||
        consent.expectedActualMicros !== view.actualMicros ||
        consent.expectedReservedSubunits !== view.reservedSubunits ||
        consent.expectedCaptureSubunits !== view.captureSubunits
      )
        fail(409, 'NPC_SETTLEMENT_CHANGED', 'NPC_SETTLEMENT_CHANGED');
      // The original hold is the idempotency boundary. Same receipt replays; a different receipt conflicts.
      let settled;
      try {
        settled = await new SparksAccounting().settle(
          c,
          owner.id,
          hold.id,
          {
            outcome: 'success',
            actualMicros: view.actualMicros,
            evidence: 'configured_rates',
            receiptId: `owner-npc-settlement:${consent.operationId}`,
          },
          true,
        );
      } catch (error) {
        if (error instanceof Error && /^SPARK_[A-Z_]+$/.test(error.message))
          fail(409, error.message, error.message);
        throw error;
      }
      if (hold.status === 'pending')
        await c.query('INSERT INTO audit(actor_id,action,target_id,details) VALUES($1,$2,$3,$4)', [
          owner.id,
          'npc.known_failure.settled',
          job.id,
          JSON.stringify({
            operationId: consent.operationId,
            holdId: hold.id,
            actualMicros: view.actualMicros,
            captureSubunits: view.captureSubunits,
            releaseSubunits: view.releaseSubunits,
          }),
        ]);
      return {
        ...view,
        status: settled.status,
        requiresConsent: false,
        ...(await this.walletView(c, owner.id)),
      };
    });
  }
  private async walletView(c: PoolClient, ownerId: string) {
    const row = (
      await c.query('SELECT balance_subunits,held_subunits FROM spark_wallets WHERE owner_id=$1', [
        ownerId,
      ])
    ).rows[0];
    return {
      sparks: {
        balanceSubunits: String(row.balance_subunits),
        heldSubunits: String(row.held_subunits),
      },
    };
  }
}

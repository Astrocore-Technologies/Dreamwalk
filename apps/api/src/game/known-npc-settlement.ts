import {
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { automaticNpcAdmission } from './automatic-npc-settlement';
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
  lifecycle: 'recovery' | 'ordinary-failure' | 'automatic' = 'recovery',
) {
  if (
    !(lifecycle !== 'ordinary-failure'
      ? ['stale', 'failed'].includes(job.status)
      : ['running', 'result_received'].includes(job.status)) ||
    job.provider_budget_status !== 'spent' ||
    job.provider_external !== true ||
    job.provider_cost_evidence !== 'configured_rates' ||
    !(
      job.subject_kind === 'npc' ||
      (job.subject_kind === 'player' &&
        (lifecycle === 'automatic' ||
          (lifecycle === 'ordinary-failure' && job.purpose === 'story_turn')))
    ) ||
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
    !(lifecycle === 'ordinary-failure'
      ? hold.status === 'held'
      : (hold.status === 'pending' && hold.reason === 'failure_policy_pending') ||
        ['settled', 'released'].includes(hold.status))
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
    BigInt(capture) > BigInt(hold.reserved_subunits) ||
    (['settled', 'released'].includes(hold.status) &&
      (String(hold.captured_subunits) !== capture ||
        hold.status !== (capture === '0' ? 'released' : 'settled')))
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
export class KnownNpcSettlement implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private recovering?: Promise<void>;
  private recoveryCursor: string | null = null;
  private readonly logger = new Logger(KnownNpcSettlement.name);
  onModuleInit() {
    void this.recoverPending();
    this.timer = setInterval(() => void this.recoverPending(), 30000);
    this.timer.unref();
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.recovering;
  }
  async recoverPending() {
    if (this.recovering) return this.recovering;
    this.recovering = this.recoverPage().catch(() => {
      this.logger.warn('NPC_AUTOMATIC_SETTLEMENT_RECOVERY_FAILED');
    });
    try {
      await this.recovering;
    } finally {
      this.recovering = undefined;
    }
  }
  private async recoverPage() {
    const rows = await this.db.query<{ id: string; campaign_id: string; payer_user_id: string }>(
      `
      SELECT j.id,j.campaign_id,j.payer_user_id FROM npc_ai_jobs j
      JOIN spark_holds h ON h.id=j.spark_hold_id
      JOIN spark_quotes q ON q.id=h.id
      WHERE j.status IN ('stale','failed') AND j.provider_budget_status='spent'
        AND j.provider_usage IS NOT NULL AND h.status='pending' AND h.reason='failure_policy_pending'
        AND ((q.price_snapshot->'providerQuote'->>'automaticKnownCostPolicy'='known-cost-v1'
            AND j.request_meta->>'automaticKnownCostPolicy'='known-cost-v1')
          OR EXISTS(SELECT 1 FROM game_world_generation_batches b WHERE b.campaign_id=j.campaign_id
            AND b.owner_id=j.payer_user_id AND b.accepted_at IS NOT NULL
            AND b.quote->>'ordinaryTurnConsentVersion'='end-turn-v1'
            AND b.entries @> jsonb_build_array(jsonb_build_object('quote',jsonb_build_object('id',j.quote_id::text)))))
        AND ($1::uuid IS NULL OR j.id>$1::uuid) ORDER BY j.id LIMIT 25`,
      [this.recoveryCursor],
    );
    for (const row of rows) {
      try {
        await this.db.tx((c) =>
          this.execute(c, row.payer_user_id, row.campaign_id, row.id, undefined, true),
        );
      } catch {
        this.logger.warn('NPC_AUTOMATIC_SETTLEMENT_JOB_FAILED');
      }
      this.recoveryCursor = row.id;
    }
    if (rows.length < 25) this.recoveryCursor = null;
  }
  constructor(
    @Inject(Db) private db: Db,
    @Inject(Auth) private auth: Auth,
    @Inject(GenerationAuthority) private authority: GenerationAuthority,
  ) {}
  async handle(req: Request, campaignId: string, jobId: string, input?: unknown) {
    const owner = await this.auth.require(req);
    z.uuid().parse(campaignId);
    z.uuid().parse(jobId);
    return this.db.tx((c) => this.execute(c, owner.id, campaignId, jobId, input));
  }
  private async execute(
    c: PoolClient,
    ownerId: string,
    campaignId: string,
    jobId: string,
    input?: unknown,
    automatic = false,
  ) {
    const owner = { id: ownerId };
    const consent = input === undefined ? undefined : consentSchema.parse(input);
    const mutate = automatic || !!consent;
    const campaign = (
      await c.query(
        `SELECT id,owner_id FROM game_campaigns WHERE id=$1${mutate ? ' FOR UPDATE' : ''}`,
        [campaignId],
      )
    ).rows[0];
    if (!campaign || campaign.owner_id !== owner.id) fail(404, 'NOT_FOUND', 'NOT_FOUND');
    const job = (
      await c.query(
        `SELECT * FROM npc_ai_jobs WHERE id=$1 AND campaign_id=$2${mutate ? ' FOR UPDATE' : ''}`,
        [jobId, campaignId],
      )
    ).rows[0];
    if (!job || job.payer_user_id !== owner.id) fail(404, 'NOT_FOUND', 'NOT_FOUND');
    if (!job.generation_authorization_id || !job.generation_reservation_id) unavailable();
    if (
      mutate &&
      !(
        await c.query(
          'SELECT provider_id FROM npc_ai_provider_budgets WHERE provider_id=$1 FOR UPDATE',
          [job.provider_id],
        )
      ).rowCount
    )
      unavailable();
    const authorization = mutate
      ? await this.authority.lockAuthorization(c, job.generation_authorization_id)
      : (
          await c.query('SELECT * FROM live_test_sessions WHERE id=$1', [
            job.generation_authorization_id,
          ])
        ).rows[0];
    const reservation = (
      await c.query('SELECT * FROM generation_budget_reservations WHERE id=$1', [
        job.generation_reservation_id,
      ])
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
    if (mutate) {
      await fenceGenerationAdmission(c);
      await c.query('SELECT owner_id FROM spark_wallets WHERE owner_id=$1 FOR UPDATE', [owner.id]);
    }
    const hold = (
      await c.query(
        `SELECT * FROM spark_holds WHERE id=$1 AND owner_id=$2${mutate ? ' FOR UPDATE' : ''}`,
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
    // Never rewrite an already terminal manual or automatic receipt.
    if (automatic && ['settled', 'released'].includes(hold.status)) return;
    const view = knownNpcSettlementQuote(
      job,
      hold,
      quote,
      automatic || quote.price_snapshot?.providerQuote?.automaticKnownCostPolicy === 'known-cost-v1'
        ? 'automatic'
        : 'recovery',
    );
    if (automatic) {
      const native = (await c.query('SELECT * FROM npc_ai_quotes WHERE id=$1', [job.quote_id]))
        .rows[0];
      const batches = job.request_meta?.runtimeRequestId
        ? (
            await c.query(
              `SELECT * FROM game_world_generation_batches
          WHERE campaign_id=$1 AND owner_id=$2 AND accepted_at IS NOT NULL
          AND entries @> jsonb_build_array(jsonb_build_object('requestId',$3::text,'quote',jsonb_build_object('id',$4::text)))
          ORDER BY id LIMIT 2`,
              [campaignId, ownerId, job.request_meta.runtimeRequestId, job.quote_id],
            )
          ).rows
        : [];
      if (batches.length > 1) return;
      const request = job.request_meta?.runtimeRequestId
        ? (
            await c.query('SELECT * FROM game_npc_decision_requests WHERE id=$1', [
              job.request_meta.runtimeRequestId,
            ])
          ).rows[0]
        : undefined;
      let dreams;
      if (hold.dream_hold_id) {
        await c.query('SELECT owner_id FROM dream_wallets WHERE owner_id=$1 FOR UPDATE', [ownerId]);
        const dh = (
          await c.query('SELECT * FROM dream_holds WHERE id=$1 AND owner_id=$2 FOR UPDATE', [
            hold.dream_hold_id,
            ownerId,
          ])
        ).rows[0];
        const dq = (
          await c.query('SELECT * FROM dream_quotes WHERE id=$1 AND owner_id=$2', [
            hold.dream_hold_id,
            ownerId,
          ])
        ).rows[0];
        if (!dh || !dq) return;
        dreams = { hold: dh, quote: dq };
      }
      if (
        !automaticNpcAdmission(
          job,
          native,
          authorization,
          reservation,
          hold,
          quote,
          batches[0],
          request,
          dreams,
        )
      )
        return;
    }
    if (!mutate) return view;
    if (
      consent &&
      (consent.holdId !== view.holdId ||
        consent.expectedActualMicros !== view.actualMicros ||
        consent.expectedReservedSubunits !== view.reservedSubunits ||
        consent.expectedCaptureSubunits !== view.captureSubunits)
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
          receiptId: automatic
            ? `automatic-npc-settlement:${job.id}`
            : `owner-npc-settlement:${consent!.operationId}`,
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
          operationId: automatic ? job.id : consent!.operationId,
          automatic,
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

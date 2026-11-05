import { currentReleaseDeployment } from './release-deployment';
import { providerMicrosToSparkSubunits } from '@dreamwalk/contracts';
import {
  quoteSparks,
  reserveSparks,
  settleReservationSparks,
  sparkTariff,
  sparkQuoteView,
} from './sparks-hooks';
import { boundedTest, boundedPolicy, createBoundedTest } from './bounded-test';
import { retainedModelRejectionAdmission } from '../image-generation/retained-rejections';
import {
  bodyHash,
  modelContext,
  type TextCountAdapter,
  type TextCountEvidence,
} from '../ai/text-preflight';
import { Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { settleKnownCount, settleKnownPermit } from './known-text-settlement';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest } from '../ai/context';
import type { AiPurpose, ProviderRequest } from '../ai/types';
import type { TextReserveSnapshot } from './estimates';
import {
  appendPolicyRevision,
  policyLiabilities,
  policyRequestHash,
  policyWorkBlockers,
  revisionReceipt,
  safeOwnerProfile,
} from './policy-revisions';
import { Db } from '../db';
import { fail } from '../errors';
import { reserveGenerationSpend, settleGenerationSpend } from '../image-generation/budget';
import {
  defaultImagePolicy,
  type ImagePolicy,
  type GenerationRequest,
} from '../image-generation/contracts';
import { sourceAccessSql } from '../game/playable.service';
import { LIVE_TEXT, type LiveTestConfig } from '../live-test/config';
import {
  ownerPricingIsCurrent,
  type OwnerGenerationConfig,
  type ReleaseGenerationConfig,
} from './config';
import { ReleaseAdmission, releaseScope } from './release';
import { releaseProfileProjection } from './release-policy';
import { aggregateGenerationExposure } from './aggregate-exposure';
import { fenceGenerationAdmission } from './scope-fence';
export const GENERATION_SCOPE_ID = LIVE_TEXT.scopeId;
const fenceSchema = z
  .object({
    roundId: z.string().min(1),
    phaseEpoch: z.number().int().min(0),
    rulesetVersion: z.literal(1),
  })
  .strict();
const consentSchema = z
  .object({
    sessionId: z.uuid().optional(),
    authorizationId: z.uuid().optional(),
    operationId: z.uuid(),
    turnFence: fenceSchema,
    estimateFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    policyRevision: z.number().int().nonnegative().optional(),
    policyHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    consent: z.literal(true),
    automaticKnownCostPolicy: z.literal('known-cost-v1').optional(),
  })
  .strict()
  .refine((v) => !v.sessionId || !v.authorizationId || v.sessionId === v.authorizationId, {
    message: 'AUTHORIZATION_ID_MISMATCH',
  });
@Injectable()
export class GenerationAuthority implements OnModuleInit, OnModuleDestroy {
  private recoveryTimer?: ReturnType<typeof setInterval>;
  private recoveringKnownText?: Promise<void>;
  private countRecoveryCursor: string | null = null;
  private permitRecoveryCursor: string | null = null;
  private readonly settlementLogger = new Logger(GenerationAuthority.name);
  onModuleInit() {
    void this.recoverKnownText();
    this.recoveryTimer = setInterval(() => void this.recoverKnownText(), 30000);
    this.recoveryTimer.unref();
  }
  async onModuleDestroy() {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    await this.recoveringKnownText;
  }
  async recoverKnownText() {
    if (this.recoveringKnownText) return this.recoveringKnownText;
    this.recoveringKnownText = this.recoverKnownTextPage().catch(() => {
      this.settlementLogger.warn('TEXT_AUTOMATIC_SETTLEMENT_RECOVERY_FAILED');
    });
    try {
      await this.recoveringKnownText;
    } finally {
      this.recoveringKnownText = undefined;
    }
  }
  private async recoverKnownTextPage() {
    const counts = await this.db.query<{ id: string; authorization_id: string }>(
      `
      SELECT j.id,j.authorization_id FROM generation_text_counts j JOIN spark_holds h ON h.id=j.spark_quote_id
      JOIN spark_quotes q ON q.id=h.id
      WHERE q.price_snapshot->'providerQuote'->>'automaticKnownCostPolicy'='known-cost-v1'
        AND q.price_snapshot->'providerQuote'->'automaticKnownCostAcceptance'->>'policy'='known-cost-v1' AND j.actual_micros IS NOT NULL AND j.input_tokens IS NOT NULL AND j.status IN ('stale','unknown','over_context','succeeded')
        AND h.status IN ('held','pending') AND ($1::uuid IS NULL OR j.id>$1::uuid) ORDER BY j.id LIMIT 25`,
      [this.countRecoveryCursor],
    );
    for (const row of counts) {
      try {
        await this.db.tx(async (c) => {
          const authorization = await this.lockAuthorization(c, row.authorization_id);
          const job = (
            await c.query('SELECT * FROM generation_text_counts WHERE id=$1 FOR UPDATE', [row.id])
          ).rows[0];
          if (job) await settleKnownCount(c, job, authorization);
        });
      } catch {
        this.settlementLogger.warn('COUNT_AUTOMATIC_SETTLEMENT_JOB_FAILED');
      }
      this.countRecoveryCursor = row.id;
    }
    if (counts.length < 25) this.countRecoveryCursor = null;
    const permits = await this.db.query<{ id: string; session_id: string; job_id: string }>(
      `
      SELECT p.id,p.session_id,p.job_id FROM live_test_text_permits p JOIN spark_holds h ON h.id=p.spark_quote_id
      JOIN spark_quotes q ON q.id=h.id
      JOIN npc_ai_jobs j ON j.id=p.job_id WHERE q.price_snapshot->'providerQuote'->>'automaticKnownCostPolicy'='known-cost-v1'
        AND q.price_snapshot->'providerQuote'->'automaticKnownCostAcceptance'->>'policy'='known-cost-v1' AND p.state='settled' AND j.status IN ('stale','failed')
        AND j.provider_usage IS NOT NULL AND h.status IN ('held','pending')
        AND ($1::uuid IS NULL OR p.id>$1::uuid) ORDER BY p.id LIMIT 25`,
      [this.permitRecoveryCursor],
    );
    for (const row of permits) {
      try {
        await this.db.tx(async (c) => {
          // NPC callback order: job, provider budget, authorization/scope, permit, fence, wallet.
          const job = (
            await c.query('SELECT * FROM npc_ai_jobs WHERE id=$1 FOR UPDATE', [row.job_id])
          ).rows[0];
          if (!job) return;
          await c.query(
            'SELECT provider_id FROM npc_ai_provider_budgets WHERE provider_id=$1 FOR UPDATE',
            [job.provider_id],
          );
          const authorization = await this.lockAuthorization(c, row.session_id);
          const permit = (
            await c.query('SELECT * FROM live_test_text_permits WHERE id=$1 FOR UPDATE', [row.id])
          ).rows[0];
          if (permit) await settleKnownPermit(c, permit, authorization);
        });
      } catch {
        this.settlementLogger.warn('PERMIT_AUTOMATIC_SETTLEMENT_JOB_FAILED');
      }
      this.permitRecoveryCursor = row.id;
    }
    if (permits.length < 25) this.permitRecoveryCursor = null;
  }
  readonly config: LiveTestConfig & { mode: 'owner' | 'manual' | 'release' };
  readonly release?: ReleaseAdmission;
  readonly ownerConfig?: OwnerGenerationConfig;
  readonly releaseConfig?: ReleaseGenerationConfig;
  get profileConfig() {
    return this.releaseConfig ?? this.ownerConfig;
  }
  private textCountAdapter?: TextCountAdapter;
  configureTextCountAdapter(adapter: TextCountAdapter) {
    this.textCountAdapter = adapter;
  }
  private countCandidate(context: Record<string, unknown>, keepRecentHistory?: number) {
    const full = structuredClone(modelContext(context.textContextCandidate ?? context)) as Record<
      string,
      unknown
    >;
    if (keepRecentHistory !== undefined && Array.isArray(full.history)) {
      // Pin records referenced by current obligations/questions as well as the newest record.
      const ids = new Set<string>([
        ...((full.requestedFactIds as string[]) ?? []),
        String(full.replyToObservationId ?? ''),
      ]);
      for (const x of [full.goal, ...((full.obligations as object[]) ?? []), full.summary])
        for (const id of (x as { evidenceIds?: string[]; observationIds?: string[] } | undefined)
          ?.evidenceIds ??
          (x as { observationIds?: string[] } | undefined)?.observationIds ??
          [])
          ids.add(id);
      const tail = new Set(full.history.slice(-Math.max(1, keepRecentHistory)));
      full.history = full.history.filter(
        (r: Record<string, unknown>) =>
          tail.has(r) || ids.has(String(r.id ?? r.observationId ?? '')),
      );
    }
    delete full.budgetExceeded;
    return full;
  }
  private countGate() {
    const price = this.profileConfig?.text.counting;
    return !this.profileConfig?.text.contextBudgetTokens
      ? 'TEXT_COUNT_WINDOW_REQUIRED'
      : !price
        ? 'TEXT_COUNT_COST_REVIEW_REQUIRED'
        : !ownerPricingIsCurrent(price.pricing)
          ? 'TEXT_COUNT_PRICING_EXPIRED'
          : !this.textCountAdapter
            ? 'TEXT_COUNT_ADAPTER_UNAVAILABLE'
            : null;
  }
  private countReceipt(row: Record<string, unknown>) {
    return {
      id: row.id,
      status:
        row.status === 'dispatched' && new Date(String(row.deadline_at)).getTime() <= Date.now()
          ? 'unknown'
          : row.status,
      inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
      resultCode: row.result_code ?? null,
      actualMicros: row.actual_micros === null ? null : Number(row.actual_micros),
      costBasis: 'owner_reviewed_fixed_rate',
      invoiceExact: false,
    };
  }
  private async countView(
    c: PoolClient,
    request: { id: string; context: Record<string, unknown> },
  ) {
    if (!this.profileConfig?.text.contextBudgetTokens) return undefined;
    const rows = (
      await c.query(
        'SELECT *,count(*) OVER() AS attempts FROM generation_text_counts WHERE request_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',
        [request.id],
      )
    ).rows;
    const candidate = this.countCandidate(request.context);
    return {
      blockCode: this.countGate(),
      automaticKnownCostPolicy: 'known-cost-v1' as const,
      candidateFingerprint: digest(candidate),
      historyRecords: Array.isArray(candidate.history) ? candidate.history.length : 0,
      reserveMicros: this.profileConfig!.text.counting?.microsPerRequest ?? null,
      attempts: Number(rows[0]?.attempts ?? 0),
      maxAttempts: 3,
      latest: rows[0] ? this.countReceipt(rows[0]) : null,
    };
  }
  /** Pure GET reconciliation never retries an uncertain count. */
  async countOperation(userId: string, operationId: string) {
    await this.owner(userId);
    z.uuid().parse(operationId);
    const row = (
      await this.db.query(
        'SELECT * FROM generation_text_counts WHERE actor_id=$1 AND operation_id=$2',
        [userId, operationId],
      )
    )[0];
    if (!row) fail(404, 'TEXT_COUNT_NOT_FOUND', 'TEXT_COUNT_NOT_FOUND');
    return this.countReceipt(row);
  }
  async assertCountEvidence(context: unknown, client?: PoolClient, expectedRequestId?: string) {
    const e = (context as { textCountEvidence?: TextCountEvidence } | null)?.textCountEvidence;
    if (!e) return;
    const run = async (c: PoolClient) => {
      const row = (
        await c.query("SELECT * FROM generation_text_counts WHERE id=$1 AND status='succeeded'", [
          e.id,
        ])
      ).rows[0];
      const active = await this.assertActivePolicy(c, row?.authorization_id);
      if (
        !row ||
        (expectedRequestId && row.request_id !== expectedRequestId) ||
        row.body_sha256 !== e.bodySha256 ||
        row.model !== e.model ||
        row.provider_version !== e.providerVersion ||
        Number(row.input_tokens) !== e.inputTokens ||
        Number(row.policy_revision) !== e.policyRevision ||
        row.policy_hash !== e.policyHash ||
        active.revision !== e.policyRevision ||
        active.hash !== e.policyHash ||
        digest(row.turn_fence) !== digest((context as Record<string, unknown>).turnFence)
      )
        fail(409, 'TEXT_COUNT_EVIDENCE_STALE', 'TEXT_COUNT_EVIDENCE_STALE');
    };
    if (client) await run(client);
    else await this.db.tx(run);
  }
  /** Only this explicitly consented POST may call the count adapter. No generation is dispatched here. */
  async preflightCount(userId: string, campaignId: string, requestId: string, input: unknown) {
    await this.owner(userId);
    z.uuid().parse(campaignId);
    z.uuid().parse(requestId);
    const v = z
      .object({
        operationId: z.uuid(),
        turnFence: fenceSchema,
        policyRevision: z.number().int().nonnegative(),
        policyHash: z.string().regex(/^[a-f0-9]{64}$/),
        candidateFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        keepRecentHistory: z.number().int().min(1).max(32768).optional(),
        consent: z.literal(true),
        automaticKnownCostPolicy: z.literal('known-cost-v1').optional(),
      })
      .strict()
      .parse(input);
    const requestHash = digest({ campaignId, requestId, ...v });
    const admitted = await this.db.tx(async (c) => {
      const authorizationId = await this.resolveAuthorizationId(c, userId);
      const prior = (
        await c.query(
          'SELECT * FROM generation_text_counts WHERE authorization_id=$1 AND operation_id=$2',
          [authorizationId, v.operationId],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_hash !== requestHash)
          fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
        return { prior };
      }
      const gate = this.countGate();
      if (gate) fail(409, gate, gate);
      const active = await this.assertActivePolicy(c, authorizationId);
      if (active.revision !== v.policyRevision || active.hash !== v.policyHash)
        fail(409, 'GENERATION_POLICY_STALE', 'GENERATION_POLICY_STALE');
      const turn = await this.campaign(c, campaignId, userId);
      if (
        digest({ roundId: turn.roundId, phaseEpoch: turn.phaseEpoch, rulesetVersion: 1 }) !==
        digest(v.turnFence)
      )
        fail(409, 'TURN_PHASE_STALE', 'TURN_PHASE_STALE');
      const row = (
        await c.query(
          "SELECT * FROM game_npc_decision_requests WHERE id=$1 AND campaign_id=$2 AND status='queued' FOR UPDATE",
          [requestId, campaignId],
        )
      ).rows[0];
      if (
        !row ||
        row.job_id ||
        (row.requester_user_id && row.requester_user_id !== userId) ||
        !['speech', 'plan', 'story_turn', 'narrative'].includes(row.purpose)
      )
        fail(409, 'LIVE_REQUEST_UNAVAILABLE', 'LIVE_REQUEST_UNAVAILABLE');
      if (
        (await c.query('SELECT 1 FROM live_test_text_permits WHERE request_id=$1', [requestId]))
          .rowCount
      )
        fail(409, 'MANUAL_REQUEST_ALREADY_AUTHORIZED', 'MANUAL_REQUEST_ALREADY_AUTHORIZED');
      if (
        (
          await c.query(
            'SELECT count(*)::int AS n FROM generation_text_counts WHERE request_id=$1',
            [requestId],
          )
        ).rows[0].n >= 3
      )
        fail(409, 'TEXT_COUNT_ATTEMPT_LIMIT', 'TEXT_COUNT_ATTEMPT_LIMIT');
      if (
        digest(this.countCandidate(row.context)) !== v.candidateFingerprint ||
        digest(row.context.turnFence) !== digest(v.turnFence)
      )
        fail(409, 'TEXT_COUNT_CANDIDATE_STALE', 'TEXT_COUNT_CANDIDATE_STALE');
      const candidate = this.countCandidate(row.context, v.keepRecentHistory);
      const body = this.textCountAdapter!.countBody(row.purpose, candidate);
      if (Buffer.byteLength(body) > this.profileConfig!.text.maxInputBytes)
        fail(413, 'TEXT_CONTEXT_TRANSPORT_LIMIT', 'TEXT_CONTEXT_TRANSPORT_LIMIT');
      const price = this.profileConfig!.text.counting!;
      const reservation = await reserveGenerationSpend(
        c,
        {
          ...(await this.effectivePolicy(c, userId)),
          costBasis: 'approved_estimate',
          verifiedUpperMicros: null,
          operationalReserveMicros: price.microsPerRequest,
        },
        userId,
        'text',
        `text-count:${v.operationId}`,
        price.microsPerRequest,
      );
      const id = randomUUID();
      const sparkQuoteId =
        price.microsPerRequest > 0
          ? await quoteSparks(
              c,
              {
                ownerId: userId,
                operationId: id,
                sourceKind: 'text',
                sourceId: `count:${id}`,
                reserveSubunits: providerMicrosToSparkSubunits(String(price.microsPerRequest)),
                expiresAt: new Date(Date.now() + 60000).toISOString(),
                tariff: sparkTariff(this.textProfile(), 'openai', this.textCountAdapter!.version),
                providerQuote: {
                  automaticKnownCostPolicy: 'known-cost-v1',
                  ...(v.automaticKnownCostPolicy === 'known-cost-v1'
                    ? {
                        automaticKnownCostAcceptance: {
                          policy: v.automaticKnownCostPolicy,
                          requestHash,
                        },
                      }
                    : {}),
                  countId: id,
                  model: this.profileConfig!.text.model,
                  providerVersion: this.textCountAdapter!.version,
                  pricing: price,
                  policy: active,
                  requestHash,
                },
              },
              { required: !!this.release },
            )
          : null;
      if (price.microsPerRequest > 0)
        await reserveSparks(c, userId, sparkQuoteId, reservation, { required: !!this.release });
      const job = (
        await c.query(
          `INSERT INTO generation_text_counts(id,authorization_id,scope_id,actor_id,campaign_id,request_id,operation_id,request_hash,source_hash,body_sha256,model,provider_version,policy_revision,policy_hash,turn_fence,pricing_snapshot,reservation_id,status,deadline_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'dispatched',clock_timestamp()+interval '60 seconds') RETURNING *`,
          [
            id,
            authorizationId,
            this.release ? releaseScope(userId) : GENERATION_SCOPE_ID,
            userId,
            campaignId,
            requestId,
            v.operationId,
            requestHash,
            digest(row.context),
            bodyHash(body),
            this.profileConfig!.text.model,
            this.textCountAdapter!.version,
            active.revision,
            active.hash,
            JSON.stringify(v.turnFence),
            JSON.stringify(price),
            reservation,
          ],
        )
      ).rows[0];
      await c.query('UPDATE generation_text_counts SET spark_quote_id=$2 WHERE id=$1', [
        id,
        sparkQuoteId,
      ]);
      return { job, candidate, purpose: row.purpose };
    });
    if (admitted.prior) return this.countReceipt(admitted.prior);
    const { job, candidate, purpose } = admitted;
    let tokens: number | null = null,
      code: string | null = null;
    try {
      tokens = await this.textCountAdapter!.count(purpose, candidate, job.id);
      if (!Number.isSafeInteger(tokens) || tokens < 0)
        throw new Error('TEXT_COUNT_INVALID_RESPONSE');
    } catch (e) {
      code =
        e instanceof Error && e.message === 'PROVIDER_HTTP_403'
          ? 'PROVIDER_HTTP_403'
          : 'TEXT_COUNT_OUTCOME_UNKNOWN';
    }
    return this.db.tx(async (c) => {
      await this.lockAuthorization(c, job.authorization_id);
      const current = (
        await c.query('SELECT * FROM generation_text_counts WHERE id=$1 FOR UPDATE', [job.id])
      ).rows[0];
      if (current.status !== 'dispatched') {
        if (current.status === 'unknown' && tokens !== null && !code) {
          await settleGenerationSpend(
            c,
            job.reservation_id,
            Number(job.pricing_snapshot.microsPerRequest),
          );
          await c.query(
            'UPDATE generation_text_counts SET actual_micros=$2,input_tokens=$3,completed_at=COALESCE(completed_at,clock_timestamp()) WHERE id=$1',
            [job.id, Number(job.pricing_snapshot.microsPerRequest), tokens],
          );
          const known = (
            await c.query('SELECT * FROM generation_text_counts WHERE id=$1', [job.id])
          ).rows[0];
          const authorization = (
            await c.query('SELECT * FROM live_test_sessions WHERE id=$1', [job.authorization_id])
          ).rows[0];
          if (known && authorization) await settleKnownCount(c, known, authorization);
        }
        return this.countReceipt(
          (await c.query('SELECT * FROM generation_text_counts WHERE id=$1', [job.id])).rows[0],
        );
      }
      const deadline = new Date(current.deadline_at).getTime() <= Date.now();
      if (code || tokens === null || deadline) {
        await settleReservationSparks(c, job.reservation_id, {
          outcome: 'unknown',
          receiptId: `count:${job.id}`,
        });
        await c.query(
          "UPDATE generation_text_counts SET status='unknown',result_code=$2,completed_at=clock_timestamp() WHERE id=$1",
          [job.id, code ?? 'TEXT_COUNT_DEADLINE_EXCEEDED'],
        );
        await c.query(
          "UPDATE live_test_sessions SET state='stopped',stop_code=COALESCE(stop_code,$2) WHERE id=$1",
          [job.authorization_id, code ?? 'TEXT_COUNT_DEADLINE_EXCEEDED'],
        );
        await c.query('UPDATE generation_budget_scopes SET blocked=true WHERE id=$1', [
          job.scope_id,
        ]);
        if (!code && tokens !== null) {
          await settleGenerationSpend(
            c,
            job.reservation_id,
            Number(job.pricing_snapshot.microsPerRequest),
          );
          await c.query(
            'UPDATE generation_text_counts SET actual_micros=$2,input_tokens=$3 WHERE id=$1',
            [job.id, Number(job.pricing_snapshot.microsPerRequest), tokens],
          );
          const known = (
            await c.query('SELECT * FROM generation_text_counts WHERE id=$1', [job.id])
          ).rows[0];
          const authorization = (
            await c.query('SELECT * FROM live_test_sessions WHERE id=$1', [job.authorization_id])
          ).rows[0];
          if (known && authorization) await settleKnownCount(c, known, authorization);
        }
      } else {
        await settleGenerationSpend(
          c,
          job.reservation_id,
          Number(job.pricing_snapshot.microsPerRequest),
        );
        const row = (
          await c.query('SELECT * FROM game_npc_decision_requests WHERE id=$1 FOR UPDATE', [
            requestId,
          ])
        ).rows[0];
        let active: { revision: number; hash: string } | null = null;
        try {
          active = await this.assertActivePolicy(c, job.authorization_id);
        } catch (error) {
          const response = (error as { getResponse?: () => { code?: string } }).getResponse?.();
          if (
            !this.release ||
            ![
              'GENERATION_POLICY_CHANGED',
              'GENERATION_RELEASE_PROFILE_NOT_ACTIVE',
              'GENERATION_ACCOUNT_REVIEW_REQUIRED',
              'GENERATION_PRICING_EXPIRED',
            ].includes(response?.code ?? '')
          )
            throw error;
          // The known provider receipt is still settled at its original fixed price.
          // A stale count is not adopted into the new model/policy context.
        }
        const campaign = (
          await c.query('SELECT state FROM game_campaigns WHERE id=$1', [campaignId])
        ).rows[0];
        const t = campaign?.state?.turnController;
        const stale =
          !active ||
          !row ||
          row.status !== 'queued' ||
          digest(row.context) !== job.source_hash ||
          active.revision !== Number(job.policy_revision) ||
          active.hash !== job.policy_hash ||
          digest({
            roundId: t?.roundId,
            phaseEpoch: t?.phaseEpoch,
            rulesetVersion: t?.ruleset?.version,
          }) !== digest(v.turnFence);
        const over =
          tokens + this.profileConfig!.text.maxOutputTokens >
          Math.min(
            this.profileConfig!.text.contextBudgetTokens!,
            this.profileConfig!.text.contextTokens,
          );
        const status = stale ? 'stale' : over ? 'over_context' : 'succeeded';
        await settleReservationSparks(
          c,
          job.reservation_id,
          stale
            ? {
                outcome: 'failure_policy_pending',
                receiptId: `count:${job.id}`,
              }
            : {
                outcome: 'success',
                actualMicros: String(job.pricing_snapshot.microsPerRequest),
                evidence: 'configured_rates',
                receiptId: `count:${job.id}`,
              },
        );
        if (!stale && !over) {
          const evidence: TextCountEvidence = {
            id: job.id,
            model: job.model,
            bodySha256: job.body_sha256,
            inputTokens: tokens,
            providerVersion: job.provider_version,
            policyRevision: Number(job.policy_revision),
            policyHash: job.policy_hash,
          };
          const counted: Record<string, unknown> = {
            ...candidate,
            textContextCandidate: row.context.textContextCandidate ?? candidate,
            textCountEvidence: evidence,
            budgetExceeded: false,
          };
          // budgetExceeded is not a model field in the counted candidate; keep its body identical.
          delete (counted as Record<string, unknown>).budgetExceeded;
          await c.query('UPDATE game_npc_decision_requests SET context=$2 WHERE id=$1', [
            requestId,
            JSON.stringify(counted),
          ]);
          if (counted.storyTurnId)
            await c.query(
              'UPDATE game_story_turns SET context=$2 WHERE id=$1 AND erased_at IS NULL',
              [counted.storyTurnId, JSON.stringify(counted)],
            );
        }
        await c.query(
          'UPDATE generation_text_counts SET status=$2,input_tokens=$3,actual_micros=$4,result_code=$5,completed_at=clock_timestamp() WHERE id=$1',
          [
            job.id,
            status,
            tokens,
            Number(job.pricing_snapshot.microsPerRequest),
            stale ? 'TEXT_COUNT_CANDIDATE_STALE' : over ? 'TEXT_CONTEXT_WINDOW_EXCEEDED' : null,
          ],
        );
        if (stale) {
          const known = (
            await c.query('SELECT * FROM generation_text_counts WHERE id=$1', [job.id])
          ).rows[0];
          const authorization = (
            await c.query('SELECT * FROM live_test_sessions WHERE id=$1', [job.authorization_id])
          ).rows[0];
          if (known && authorization) await settleKnownCount(c, known, authorization);
        }
      }
      return this.countReceipt(
        (await c.query('SELECT * FROM generation_text_counts WHERE id=$1', [job.id])).rows[0],
      );
    });
  }
  private textRequestPlanner?: (purpose: AiPurpose, context: unknown) => TextReserveSnapshot;
  configureTextRequestPlanner(
    planner: (purpose: AiPurpose, context: unknown) => TextReserveSnapshot,
  ) {
    this.textRequestPlanner = planner;
  }
  private requestEstimate(purpose: AiPurpose, context: unknown) {
    if (this.profileConfig?.text.estimation && !this.textRequestPlanner)
      fail(409, 'GENERATION_TEXT_PLANNER_REQUIRED', 'GENERATION_TEXT_PLANNER_REQUIRED');
    return this.textRequestPlanner?.(purpose, context) ?? null;
  }
  constructor(
    readonly db: Db,
    configuration: LiveTestConfig | OwnerGenerationConfig | ReleaseGenerationConfig,
  ) {
    if ('mode' in configuration && configuration.mode === 'release') {
      this.releaseConfig = structuredClone(configuration);
      this.release = new ReleaseAdmission(this.releaseConfig);
      this.config = { enabled: true, mode: 'release', estimateRiskApproved: true };
      return;
    }
    if ('mode' in configuration && configuration.mode === 'owner') {
      this.ownerConfig = structuredClone(configuration);
      if (
        'scopeId' in configuration ||
        'scopeId' in configuration.text ||
        'scopeId' in configuration.image
      )
        fail(409, 'GENERATION_SCOPE_IMMUTABLE', 'GENERATION_SCOPE_IMMUTABLE');
      const caps = [
        configuration.totalCapMicros,
        configuration.textCapMicros,
        configuration.imageCapMicros,
        configuration.text.upperMicros,
      ];
      if (
        caps.some((n) => !Number.isSafeInteger(n) || n <= 0) ||
        !/^[a-z0-9_]{3,30}$/.test(configuration.ownerHandle) ||
        !/^[a-f0-9]{64}$/.test(configuration.configFingerprint)
      )
        fail(409, 'GENERATION_CONFIG_INVALID', 'GENERATION_CONFIG_INVALID');
      this.config = { enabled: true, mode: 'owner', estimateRiskApproved: true };
    } else this.config = { ...(configuration as LiveTestConfig), mode: 'manual' };
  }
  get mode() {
    return this.config.mode;
  }
  textProfile() {
    return this.profileConfig?.text ?? LIVE_TEXT;
  }
  textUpperMicros() {
    return this.textProfile().upperMicros;
  }
  budgetCaps() {
    if (this.release) fail(409, 'GENERATION_ACTOR_REQUIRED', 'GENERATION_ACTOR_REQUIRED');
    return this.ownerConfig
      ? {
          totalCapMicros: this.ownerConfig!.totalCapMicros,
          textCapMicros: this.ownerConfig!.textCapMicros,
          imageCapMicros: this.ownerConfig!.imageCapMicros,
        }
      : {
          totalCapMicros: LIVE_TEXT.capMicros,
          textCapMicros: LIVE_TEXT.capMicros,
          imageCapMicros: LIVE_TEXT.capMicros,
        };
  }
  private identity() {
    return this.ownerConfig ? digest(this.ownerConfig) : null;
  }
  private pricingCurrent() {
    return (
      !this.ownerConfig ||
      (ownerPricingIsCurrent(this.ownerConfig.text.pricing) &&
        ownerPricingIsCurrent(this.ownerConfig.image.pricing))
    );
  }
  private async owner(userId: string) {
    if (this.release) {
      const rows = await this.db.query('SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL', [
        userId,
      ]);
      if (!rows.length) fail(403, 'FORBIDDEN', 'FORBIDDEN');
      return;
    }
    if (!this.config.enabled) fail(409, 'LIVE_TEST_DISABLED', 'LIVE_TEST_DISABLED');
    if (!this.ownerConfig) {
      if (userId !== this.config.ownerId) fail(403, 'FORBIDDEN', 'FORBIDDEN');
      return;
    }
    const rows = await this.db.query(
      'SELECT id FROM users WHERE id=$1 AND handle=$2 AND deleted_at IS NULL',
      [userId, this.ownerConfig.ownerHandle],
    );
    if (!rows.length) fail(403, 'FORBIDDEN', 'FORBIDDEN');
    const pinned = await this.db.query(
      "SELECT owner_id FROM live_test_sessions WHERE scope_id=$1 AND mode='owner'",
      [GENERATION_SCOPE_ID],
    );
    if (pinned[0] && pinned[0].owner_id !== userId)
      fail(403, 'GENERATION_OWNER_IMMUTABLE', 'GENERATION_OWNER_IMMUTABLE');
  }
  private async ownerTx(c: PoolClient, userId: string) {
    if (this.release) {
      await this.release.actor(c, userId);
      return;
    }
    const row = (
      await c.query('SELECT id,handle FROM users WHERE id=$1 AND deleted_at IS NULL FOR SHARE', [
        userId,
      ])
    ).rows[0];
    if (
      !row ||
      (this.ownerConfig
        ? row.handle !== this.ownerConfig.ownerHandle
        : userId !== this.config.ownerId)
    )
      fail(403, 'FORBIDDEN', 'FORBIDDEN');
  }
  private policy(): ImagePolicy {
    return {
      ...defaultImagePolicy,
      scopeId: GENERATION_SCOPE_ID,
      approved: true,
      externalEnabled: true,
      verifiedUpperMicros: this.textUpperMicros(),
      ...this.budgetCaps(),
    };
  }
  private async effectivePolicy(c: PoolClient, userId?: string): Promise<ImagePolicy> {
    if (this.release) {
      if (!userId) fail(403, 'GENERATION_ACTOR_REQUIRED', 'GENERATION_ACTOR_REQUIRED');
      return this.release.policy(c, userId!);
    }
    const policy = this.policy();
    if (
      policy.totalCapMicros === null ||
      policy.textCapMicros === null ||
      policy.imageCapMicros === null
    )
      return fail(409, 'GENERATION_BOUNDED_POLICY_REQUIRED', 'GENERATION_BOUNDED_POLICY_REQUIRED');
    const scope = (
      await c.query(
        'SELECT total_cap_micros,text_cap_micros,image_cap_micros FROM generation_budget_scopes WHERE id=$1',
        [GENERATION_SCOPE_ID],
      )
    ).rows[0];
    if (!scope) fail(409, 'GENERATION_CONSENT_REQUIRED', 'GENERATION_CONSENT_REQUIRED');
    const owner = this.ownerConfig
      ? (
          await c.query(
            "SELECT id,policy_revision,policy_hash FROM live_test_sessions WHERE scope_id=$1 AND mode='owner'",
            [GENERATION_SCOPE_ID],
          )
        ).rows[0]
      : null;
    return {
      ...policy,
      ...(owner
        ? {
            generationMode: 'owner' as const,
            generationAuthorizationId: owner.id,
            generationConfigFingerprint: this.ownerConfig!.configFingerprint,
            generationPolicyRevision: Number(owner.policy_revision),
            generationPolicyHash: owner.policy_hash ?? this.identity()!,
          }
        : {}),
      totalCapMicros: Math.min(policy.totalCapMicros, Number(scope.total_cap_micros)),
      textCapMicros: Math.min(policy.textCapMicros, Number(scope.text_cap_micros)),
      imageCapMicros: Math.min(policy.imageCapMicros, Number(scope.image_cap_micros)),
    };
  }
  /** Existing financial identity is retained; this is not a new allowance or reconciliation. */
  private async historicalSafety(
    c: PoolClient,
    userId: string,
    firstClaim = false,
    imageOnlyAdmission = false,
  ) {
    const unsafe = (
      await c.query(
        `SELECT 1 FROM generation_budget_reservations r JOIN generation_budget_scopes b ON b.id=r.scope_id
       WHERE ((r.scope_id<>$1 OR $2::boolean) AND r.status='held' AND r.upper_micros>0) OR (r.status='settled' AND r.actual_micros IS NULL)
       UNION ALL SELECT 1 FROM generation_budget_scopes b WHERE blocked AND NOT($3::boolean AND id=$1) AND (approved OR id=$1 OR EXISTS(SELECT 1 FROM generation_budget_reservations r WHERE r.scope_id=b.id AND (r.upper_micros>0 OR r.actual_micros>0)))
       UNION ALL SELECT 1 FROM live_test_sessions WHERE scope_id=$1 AND state='stopped' AND COALESCE(stop_code,'')<>'OWNER_GENERATION_MODE_ACTIVE' AND NOT($3::boolean AND mode='owner' AND stop_code='IMAGE_RESULT_UNKNOWN')
       LIMIT 1`,
        [GENERATION_SCOPE_ID, firstClaim, imageOnlyAdmission],
      )
    ).rowCount;
    if (unsafe)
      fail(409, 'GENERATION_PRIOR_LIABILITY_UNRESOLVED', 'GENERATION_PRIOR_LIABILITY_UNRESOLVED');
    const priorOwner = (
      await c.query('SELECT 1 FROM live_test_sessions WHERE scope_id=$1 AND owner_id<>$2 LIMIT 1', [
        GENERATION_SCOPE_ID,
        userId,
      ])
    ).rowCount;
    if (priorOwner) fail(403, 'GENERATION_OWNER_IMMUTABLE', 'GENERATION_OWNER_IMMUTABLE');
    const foreignOwner = (
      await c.query(
        'SELECT 1 FROM generation_budget_reservations WHERE scope_id=$1 AND (actor_id IS NULL OR actor_id<>$2) LIMIT 1',
        [GENERATION_SCOPE_ID, userId],
      )
    ).rowCount;
    if (foreignOwner) fail(403, 'GENERATION_OWNER_IMMUTABLE', 'GENERATION_OWNER_IMMUTABLE');
    // Unknown provider outcomes and permanent authorization denials survive mode/scope changes,
    // even when an old reservation was zero or later marked settled.
    const priorOutcome = (
      await c.query(
        `
      SELECT 1 FROM image_generation_jobs j JOIN generation_budget_reservations r ON r.id=j.reservation_id
      WHERE (r.scope_id<>$1 OR $2::boolean) AND j.mode='external' AND NOT EXISTS(SELECT 1 FROM image_generation_recoveries recovery WHERE recovery.job_id=j.id AND recovery.scope_id=r.scope_id AND j.status='rejected' AND r.status='settled' AND recovery.actual_micros=r.actual_micros) AND (j.status='unknown' OR j.safe_diagnostic->>'httpStatus'='403' OR (j.status='dispatched' AND j.dispatch_deadline<=now()))
      UNION ALL SELECT 1 FROM live_test_text_permits p JOIN live_test_sessions a ON a.id=p.session_id
      WHERE (a.scope_id<>$1 OR $2::boolean) AND (p.state='unknown' OR p.result_code='PROVIDER_HTTP_403' OR (p.state='dispatched' AND p.dispatched_at<=now()-interval '60 seconds'))
      UNION ALL SELECT 1 FROM generation_text_counts WHERE status='unknown' OR (status='dispatched' AND deadline_at<=now())
      UNION ALL SELECT 1 FROM live_authoring_text_jobs j JOIN live_test_sessions a ON a.id=j.session_id
      WHERE (a.scope_id<>$1 OR $2::boolean) AND (j.status='unknown' OR j.error_code='PROVIDER_HTTP_403' OR (j.status='dispatched' AND j.deadline_at<=now())) LIMIT 1`,
        [GENERATION_SCOPE_ID, firstClaim],
      )
    ).rowCount;
    if (priorOutcome)
      fail(409, 'GENERATION_PRIOR_LIABILITY_UNRESOLVED', 'GENERATION_PRIOR_LIABILITY_UNRESOLVED');
    // Older unwrapped NPC providers have their own ledger. Never discard or silently
    // remap it into the owner allowance; only jobs already linked to the shared ledger
    // (or explicitly recorded as free mocks) are accounted for here.
    const legacyNpc = (
      await c.query(`WITH accounted_jobs AS (
      SELECT j.id,j.provider_id,j.provider_budget_status,j.provider_upper_micros,j.provider_actual_micros FROM npc_ai_jobs j WHERE j.provider_external=false
      OR (j.generation_authorization_id IS NOT NULL AND j.status='reserved' AND j.started_at IS NULL
        AND j.deadline_at IS NULL AND j.provider_request_id IS NULL AND j.result_at IS NULL AND j.result_code IS NULL
        AND j.provider_budget_status='reserved' AND COALESCE(j.provider_actual_micros,0)=0
        AND NOT EXISTS(SELECT 1 FROM live_test_text_permits p WHERE p.job_id=j.id OR p.request_id::text=j.request_meta->>'runtimeRequestId'))
      OR EXISTS(
        SELECT 1 FROM live_test_text_permits p JOIN generation_budget_reservations r ON r.id=p.reservation_id
        WHERE (p.job_id=j.id OR p.request_id::text=j.request_meta->>'runtimeRequestId')
        AND ((j.provider_budget_status='reserved' AND r.status='held' AND r.upper_micros>=j.provider_upper_micros)
          OR (j.provider_budget_status='spent' AND r.status='settled' AND r.actual_micros=j.provider_actual_micros)
          OR (j.provider_budget_status='unknown' AND r.status='held' AND r.upper_micros>=j.provider_upper_micros)
          OR (j.provider_budget_status IN ('none','released') AND COALESCE(j.provider_actual_micros,0)=0))
      )
    ), accounted_budgets AS (
      SELECT provider_id,
      COALESCE(sum(CASE WHEN provider_budget_status='reserved' THEN provider_upper_micros ELSE 0 END),0) reserved,
      COALESCE(sum(CASE WHEN provider_budget_status='spent' THEN provider_actual_micros ELSE 0 END),0) spent,
      COALESCE(sum(CASE WHEN provider_budget_status='unknown' THEN provider_upper_micros ELSE 0 END),0) unknown
      FROM accounted_jobs GROUP BY provider_id
    ), provider_kind AS (SELECT provider_id,bool_and(provider_external IS FALSE) only_mock FROM npc_ai_jobs GROUP BY provider_id
    ) SELECT 1 FROM npc_ai_jobs j WHERE j.provider_external IS DISTINCT FROM false
      AND NOT EXISTS(SELECT 1 FROM accounted_jobs a WHERE a.id=j.id)
      AND (j.provider_budget_status='unknown' OR j.provider_actual_micros>0
        OR (j.provider_budget_status='reserved' AND j.provider_upper_micros>0)
        OR (j.status IN ('running','reconciling') AND (j.provider_upper_micros>0 OR j.provider_external=true))
        OR j.result_code='PROVIDER_HTTP_403')
    UNION ALL SELECT 1 FROM npc_ai_provider_budgets b LEFT JOIN accounted_budgets a ON a.provider_id=b.provider_id LEFT JOIN provider_kind k ON k.provider_id=b.provider_id
      WHERE b.reserved_micros>COALESCE(a.reserved,0) OR b.spent_micros>COALESCE(a.spent,0)
      OR b.unknown_micros>COALESCE(a.unknown,0) OR (b.overrun_micros>0 AND NOT COALESCE(k.only_mock,false))
      OR (b.blocked AND b.cap_micros>0 AND (NOT EXISTS(SELECT 1 FROM npc_ai_jobs j WHERE j.provider_id=b.provider_id)
        OR EXISTS(SELECT 1 FROM npc_ai_jobs j WHERE j.provider_id=b.provider_id AND j.provider_external IS DISTINCT FROM false)))
      LIMIT 1`)
    ).rowCount;
    if (legacyNpc)
      fail(
        409,
        'GENERATION_PRIOR_NPC_RECONCILIATION_REQUIRED',
        'GENERATION_PRIOR_NPC_RECONCILIATION_REQUIRED',
      );
    const foreignSpend = (
      await c.query(
        "SELECT 1 FROM generation_budget_reservations WHERE scope_id<>$1 AND (actor_id=$2 OR actor_id IS NULL) AND status='settled' AND actual_micros>0 LIMIT 1",
        [GENERATION_SCOPE_ID, userId],
      )
    ).rowCount;
    if (foreignSpend)
      fail(
        409,
        'GENERATION_PRIOR_SCOPE_RECONCILIATION_REQUIRED',
        'GENERATION_PRIOR_SCOPE_RECONCILIATION_REQUIRED',
      );
  }
  /** Authorization (nonkey writes) then shared scope, also used by settlement paths.
   * NO KEY UPDATE preserves serialization while allowing job FK KEY SHARE under admission. */
  async lockAuthorization(c: PoolClient, id: string) {
    const peek = (await c.query('SELECT scope_id FROM live_test_sessions WHERE id=$1', [id]))
      .rows[0];
    if (!peek) return undefined;
    // Migrated scopes retain a manual row as well as their owner row. Every path
    // locks that entire set in the same order before touching the scope.
    const rows = (
      await c.query(
        'SELECT * FROM live_test_sessions WHERE scope_id=$1 ORDER BY id FOR NO KEY UPDATE',
        [peek.scope_id],
      )
    ).rows;
    await c.query('SELECT id FROM generation_budget_scopes WHERE id=$1 FOR UPDATE', [
      peek.scope_id,
    ]);
    return rows.find((row) => row.id === id);
  }
  /** Provenance only for an undispatched prepared job; never grants dispatch or reserves shared funds. */
  async preparedAuthorizationId(c: PoolClient, actorId?: string): Promise<string | null> {
    if (this.release) {
      if (!actorId) fail(403, 'GENERATION_ACTOR_REQUIRED', 'GENERATION_ACTOR_REQUIRED');
      return (
        (
          await c.query(
            "SELECT id FROM live_test_sessions WHERE owner_id=$1 AND mode='release' AND state='active' AND config_hash=$2",
            [actorId, this.release.config.configFingerprint],
          )
        ).rows[0]?.id ?? null
      );
    }
    if (!this.config.enabled) return null;
    const row = this.ownerConfig
      ? (
          await c.query(
            "SELECT id FROM live_test_sessions WHERE scope_id=$1 AND mode='owner' AND config_hash=$2 AND owner_handle=$3",
            [GENERATION_SCOPE_ID, this.identity(), this.ownerConfig.ownerHandle],
          )
        ).rows[0]
      : (
          await c.query(
            "SELECT id FROM live_test_sessions WHERE id=$1 AND owner_id=$2 AND mode='manual'",
            [this.config.sessionId, this.config.ownerId],
          )
        ).rows[0];
    return row?.id ?? null;
  }
  /** Queue provenance is read-only: consent already reserved the payer's Sparks.
   * Never acquire scope/wallet locks before the NPC provider-budget row. */
  async preparedReleaseAuthorization(
    c: PoolClient,
    requestId: string | undefined,
    campaignId: string,
    context: unknown,
    requesterId?: string,
  ) {
    if (!this.release || !requestId)
      fail(409, 'GENERATION_CONSENT_REQUIRED', 'GENERATION_CONSENT_REQUIRED');
    const row = (
      await c.query(
        `SELECT s.id,s.owner_id,p.context_hash,p.request_snapshot,p.spark_quote_id,h.status AS spark_status,r.status AS reserve_status,r.actor_id
      FROM live_test_text_permits p JOIN live_test_sessions s ON s.id=p.session_id
      JOIN generation_budget_reservations r ON r.id=p.reservation_id
      JOIN spark_holds h ON h.id=p.spark_quote_id AND h.owner_id=s.owner_id
      WHERE p.request_id=$1 AND p.campaign_id=$2 AND p.state='authorized' AND s.mode='release'
      AND s.state='active' AND s.scope_id=$3||s.owner_id::text AND s.config_hash=$4`,
        [requestId, campaignId, 'release:', this.release!.config.configFingerprint],
      )
    ).rows[0];
    if (
      !row ||
      row.context_hash !== digest(context) ||
      row.actor_id !== row.owner_id ||
      row.spark_status !== 'held' ||
      row.reserve_status !== 'held' ||
      (requesterId && requesterId !== row.owner_id)
    )
      fail(409, 'GENERATION_CONSENT_REQUIRED', 'GENERATION_CONSENT_REQUIRED');
    return {
      authorizationId: row.id as string,
      payerId: row.owner_id as string,
      requestSnapshot: row.request_snapshot as TextReserveSnapshot | null,
    };
  }
  async authorizationId(userId: string): Promise<string | undefined> {
    if (this.release) {
      await this.owner(userId);
      return (
        await this.db.query(
          "SELECT id FROM live_test_sessions WHERE owner_id=$1 AND mode='release'",
          [userId],
        )
      )[0]?.id;
    }
    await this.owner(userId);
    if (!this.ownerConfig) return this.config.sessionId;
    const row = (
      await this.db.query(
        "SELECT id,owner_id,config_hash FROM live_test_sessions WHERE scope_id=$1 AND mode='owner'",
        [GENERATION_SCOPE_ID],
      )
    )[0];
    if (row && (row.owner_id !== userId || row.config_hash !== this.identity()))
      fail(409, 'GENERATION_CONFIG_IMMUTABLE', 'GENERATION_CONFIG_IMMUTABLE');
    return row?.id;
  }
  async resolveAuthorizationId(
    c: PoolClient,
    userId: string,
    suppliedId?: string,
    purpose: 'text' | 'image' = 'text',
  ): Promise<string> {
    if (this.release) return this.release.ensure(c, userId, suppliedId);
    await this.ownerTx(c, userId);
    let id = suppliedId;
    if (this.ownerConfig) {
      const row = (
        await c.query("SELECT id FROM live_test_sessions WHERE scope_id=$1 AND mode='owner'", [
          GENERATION_SCOPE_ID,
        ])
      ).rows[0];
      if (!row) fail(409, 'GENERATION_CONSENT_REQUIRED', 'GENERATION_CONSENT_REQUIRED');
      if (id && id !== row.id)
        fail(403, 'GENERATION_AUTHORIZATION_FORBIDDEN', 'GENERATION_AUTHORIZATION_FORBIDDEN');
      id = row.id;
    }
    if (!id) fail(403, 'LIVE_SESSION_FORBIDDEN', 'LIVE_SESSION_FORBIDDEN');
    await this.session(c, id!, userId, purpose);
    return id!;
  }
  private async enableExclusiveScope(c: PoolClient) {
    if (!this.config.estimateRiskApproved) return;
    const row = (
      await c.query(
        'SELECT serialize_outstanding FROM generation_budget_scopes WHERE id=$1 FOR UPDATE',
        [GENERATION_SCOPE_ID],
      )
    ).rows[0];
    if (!row || row.serialize_outstanding) return;
    const held = Number(
      (
        await c.query(
          "SELECT count(*) AS count FROM generation_budget_reservations WHERE scope_id=$1 AND status='held'",
          [GENERATION_SCOPE_ID],
        )
      ).rows[0].count,
    );
    if (held > 1)
      fail(
        409,
        'LIVE_EXISTING_RESERVATIONS_REQUIRE_RESOLUTION',
        'LIVE_EXISTING_RESERVATIONS_REQUIRE_RESOLUTION',
      );
    await c.query('UPDATE generation_budget_scopes SET serialize_outstanding=true WHERE id=$1', [
      GENERATION_SCOPE_ID,
    ]);
  }
  async claim(userId: string, input: unknown) {
    if (this.release) fail(409, 'RELEASE_CLAIM_NOT_REQUIRED', 'RELEASE_CLAIM_NOT_REQUIRED');
    await this.owner(userId);
    if (this.ownerConfig) {
      const claim = z
        .object({
          consent: z.literal(true),
          candidateFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
        .parse(input);
      if (claim.candidateFingerprint !== this.ownerConfig.configFingerprint)
        fail(409, 'GENERATION_POLICY_STALE', 'GENERATION_POLICY_STALE');
    } else {
      z.object({ consent: z.literal(true) })
        .strict()
        .parse(input);
    }
    if (!this.pricingCurrent())
      fail(409, 'GENERATION_PRICING_EXPIRED', 'GENERATION_PRICING_EXPIRED');
    if (
      !this.ownerConfig &&
      (!this.config.expiresAt || this.config.expiresAt.getTime() <= Date.now())
    )
      fail(409, 'LIVE_TEST_EXPIRED', 'LIVE_TEST_EXPIRED');
    await this.db.tx(async (c) => {
      await this.ownerTx(c, userId);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `generation-claim:${GENERATION_SCOPE_ID}`,
      ]);
      const sessions = (
        await c.query(
          'SELECT * FROM live_test_sessions WHERE scope_id=$1 ORDER BY id FOR NO KEY UPDATE',
          [GENERATION_SCOPE_ID],
        )
      ).rows;
      const owner = sessions.find((row) => row.mode === 'owner');
      if (!this.ownerConfig && owner)
        fail(409, 'GENERATION_MODE_IMMUTABLE', 'GENERATION_MODE_IMMUTABLE');
      if (this.ownerConfig && sessions.some((row) => row.owner_id !== userId))
        fail(403, 'GENERATION_OWNER_IMMUTABLE', 'GENERATION_OWNER_IMMUTABLE');
      const caps = this.budgetCaps();
      await c.query(
        'INSERT INTO generation_budget_scopes(id,approved,total_cap_micros,image_cap_micros,text_cap_micros) VALUES($1,true,$2,$3,$4) ON CONFLICT DO NOTHING',
        [GENERATION_SCOPE_ID, caps.totalCapMicros, caps.imageCapMicros, caps.textCapMicros],
      );
      const scope = (
        await c.query('SELECT * FROM generation_budget_scopes WHERE id=$1 FOR UPDATE', [
          GENERATION_SCOPE_ID,
        ])
      ).rows[0];
      if (this.ownerConfig) {
        await fenceGenerationAdmission(c);
        if (owner) {
          if (
            owner.config_hash !== this.identity() ||
            owner.owner_handle !== this.ownerConfig.ownerHandle ||
            Number(owner.cap_micros) !== Number(scope.total_cap_micros) ||
            Number(owner.text_cap_micros) !== Number(scope.text_cap_micros) ||
            Number(owner.image_cap_micros) !== Number(scope.image_cap_micros)
          )
            fail(409, 'GENERATION_CONFIG_IMMUTABLE', 'GENERATION_CONFIG_IMMUTABLE');
          if (owner.state !== 'active' || scope.blocked || !scope.approved)
            fail(409, 'LIVE_SESSION_STOPPED', 'LIVE_SESSION_STOPPED');
          // An idempotent legacy claim does not create a new epoch beneath existing jobs.
          // A reviewed amendment performs that upgrade only after the normal busy checks.
          return;
        }
        if (!scope.approved)
          fail(
            409,
            'GENERATION_PRIOR_AUTHORIZATION_REVOKED',
            'GENERATION_PRIOR_AUTHORIZATION_REVOKED',
          );
        await this.historicalSafety(c, userId, true);
        // A mode change cannot raise a historical ceiling. Explicit budget amendment is separate.
        caps.totalCapMicros = Math.min(caps.totalCapMicros, Number(scope.total_cap_micros));
        caps.textCapMicros = Math.min(caps.textCapMicros, Number(scope.text_cap_micros));
        caps.imageCapMicros = Math.min(caps.imageCapMicros, Number(scope.image_cap_micros));
        const usage = (
          await c.query(
            "SELECT COALESCE(sum(CASE WHEN status='held' THEN upper_micros WHEN status='settled' THEN actual_micros ELSE 0 END),0) total,COALESCE(sum(CASE WHEN kind='text' AND status='settled' THEN actual_micros ELSE 0 END),0) text,COALESCE(sum(CASE WHEN kind='image' AND status='settled' THEN actual_micros ELSE 0 END),0) image FROM generation_budget_reservations WHERE scope_id=$1",
            [GENERATION_SCOPE_ID],
          )
        ).rows[0];
        if (
          Number(usage.total) > caps.totalCapMicros ||
          Number(usage.text) > caps.textCapMicros ||
          Number(usage.image) > caps.imageCapMicros
        )
          fail(
            409,
            'GENERATION_CAP_BELOW_HISTORICAL_SPEND',
            'GENERATION_CAP_BELOW_HISTORICAL_SPEND',
          );
        await c.query(
          'UPDATE generation_budget_scopes SET total_cap_micros=$2,text_cap_micros=$3,image_cap_micros=$4,serialize_outstanding=true WHERE id=$1',
          [GENERATION_SCOPE_ID, caps.totalCapMicros, caps.textCapMicros, caps.imageCapMicros],
        );
        const ownerAuthorizationId = randomUUID();
        await c.query(
          "INSERT INTO live_test_sessions(id,owner_id,scope_id,expires_at,cap_micros,state,mode,config_hash,owner_handle,text_cap_micros,image_cap_micros) VALUES($1,$2,$3,NULL,$4,'active','owner',$5,$6,$7,$8)",
          [
            ownerAuthorizationId,
            userId,
            GENERATION_SCOPE_ID,
            caps.totalCapMicros,
            this.identity(),
            this.ownerConfig.ownerHandle,
            caps.textCapMicros,
            caps.imageCapMicros,
          ],
        );
        await appendPolicyRevision(c, {
          authorizationId: ownerAuthorizationId,
          scopeId: GENERATION_SCOPE_ID,
          revision: 1,
          hash: this.identity()!,
          previousHash: null,
          config: { ...this.ownerConfig, ...caps },
          operationId: randomUUID(),
          requestHash: policyRequestHash({ kind: 'initial_claim', hash: this.identity() }),
        });
        await c.query(
          "UPDATE live_test_sessions SET state='stopped',stop_code=COALESCE(stop_code,'OWNER_GENERATION_MODE_ACTIVE') WHERE scope_id=$1 AND mode='manual' AND state='active'",
          [GENERATION_SCOPE_ID],
        );
      } else {
        await c.query(
          "INSERT INTO live_test_sessions(id,owner_id,scope_id,expires_at,cap_micros,state) VALUES($1,$2,$3,$4,1000000,'active') ON CONFLICT DO NOTHING",
          [this.config.sessionId, userId, GENERATION_SCOPE_ID, this.config.expiresAt],
        );
        await this.enableExclusiveScope(c);
        const row = (
          await c.query("SELECT * FROM live_test_sessions WHERE scope_id=$1 AND mode='manual'", [
            GENERATION_SCOPE_ID,
          ])
        ).rows[0];
        if (
          !row ||
          row.id !== this.config.sessionId ||
          row.owner_id !== userId ||
          new Date(row.expires_at).getTime() !== this.config.expiresAt!.getTime()
        )
          fail(409, 'LIVE_GRANT_IMMUTABLE', 'LIVE_GRANT_IMMUTABLE');
      }
    });
    return this.status(userId);
  }
  async requireOwner(userId: string) {
    await this.owner(userId);
  }
  async createBoundedAuthoringTest(userId: string, body: unknown) {
    if (this.release) fail(403, 'OPERATOR_ONLY', 'OPERATOR_ONLY');
    await this.owner(userId);
    if (!this.ownerConfig)
      fail(409, 'GENERATION_OWNER_MODE_REQUIRED', 'GENERATION_OWNER_MODE_REQUIRED');
    return this.db.tx(async (c) => {
      const result = await createBoundedTest(c, userId, body, this.ownerConfig!);
      return {
        authorizationId: result.authorization_id,
        adventureId: result.adventure_id,
        capMicros: Number(result.cap_micros),
        aggregateCapMicros: Number(result.aggregate_cap_micros),
        retainedMicros: 66900,
        expiresAt: result.expires_at,
        policyHash: result.policy_hash,
        policyRevision: 1,
        automaticallyDispatched: false,
      };
    });
  }
  async boundedAuthoringStatus(userId: string, id: string) {
    await this.owner(userId);
    z.uuid().parse(id);
    return this.db.tx(async (c) => {
      const test = await boundedTest(c, id);
      if (!test || test.owner_id !== userId) fail(404, 'NOT_FOUND', 'NOT_FOUND');
      const session = await this.lockAuthorization(c, id);
      await fenceGenerationAdmission(c);
      const amounts = (
        await c.query(
          "SELECT COALESCE(sum(CASE WHEN status='held' THEN upper_micros WHEN status='settled' THEN actual_micros ELSE 0 END),0) used,COALESCE(sum(CASE WHEN status='held' THEN upper_micros ELSE 0 END),0) held FROM generation_budget_reservations WHERE scope_id=$1",
          [test!.scope_id],
        )
      ).rows[0];
      let blockCode: string | null = null;
      try {
        await boundedPolicy(c, test!, userId, this.ownerConfig!);
      } catch (e) {
        blockCode = e instanceof Error ? e.message : 'BOUNDED_TEST_BLOCKED';
      }
      return {
        authorizationId: id,
        adventureId: test!.adventure_id,
        state: blockCode ? 'stopped' : session?.state,
        capMicros: Number(test!.cap_micros),
        usedMicros: Number(amounts.used),
        heldMicros: Number(amounts.held),
        remainingMicros: Math.max(0, Number(test!.cap_micros) - Number(amounts.used)),
        retainedMicros: 66900,
        aggregateCapMicros: Number(test!.aggregate_cap_micros),
        expiresAt: test!.expires_at,
        policyRevision: 1,
        policyHash: test!.policy_hash,
        blockCode,
      };
    });
  }
  async authorizeReleaseResult(
    c: PoolClient,
    actorId: string,
    authorizationId: string,
    revision: number,
    hash: string,
  ) {
    if (!this.release)
      fail(409, 'GENERATION_RELEASE_MODE_REQUIRED', 'GENERATION_RELEASE_MODE_REQUIRED');
    await this.release!.result(c, authorizationId, actorId, revision, hash);
  }
  async authorizeText(
    c: PoolClient,
    userId: string,
    sessionId: string | undefined,
    singleOutstanding = false,
  ): Promise<ImagePolicy> {
    if (this.release) return this.release.policy(c, userId, sessionId);
    await this.owner(userId);
    const test = await boundedTest(c, sessionId);
    if (test) {
      await this.lockAuthorization(c, test.authorization_id);
      return boundedPolicy(c, test, userId, this.ownerConfig!);
    }
    if (
      !(
        await c.query('SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL FOR SHARE', [userId])
      ).rowCount
    )
      fail(403, 'FORBIDDEN', 'FORBIDDEN');
    await this.resolveAuthorizationId(c, userId, sessionId);
    if (singleOutstanding) {
      const count = Number(
        (
          await c.query(
            "SELECT count(*) AS count FROM generation_budget_reservations WHERE scope_id=$1 AND status='held'",
            [GENERATION_SCOPE_ID],
          )
        ).rows[0].count,
      );
      if (count > 1)
        fail(
          409,
          'LIVE_EXISTING_RESERVATIONS_REQUIRE_RESOLUTION',
          'LIVE_EXISTING_RESERVATIONS_REQUIRE_RESOLUTION',
        );
      await c.query('UPDATE generation_budget_scopes SET serialize_outstanding=true WHERE id=$1', [
        GENERATION_SCOPE_ID,
      ]);
    }
    return this.effectivePolicy(c);
  }
  private async overdueDispatch(c: PoolClient, reservationId: string) {
    return !!(
      await c.query(
        `SELECT 1 FROM live_test_text_permits WHERE reservation_id=$1
      AND (state='unknown' OR (state='dispatched' AND dispatched_at<=clock_timestamp()-interval '60 seconds'))
      UNION ALL SELECT 1 FROM live_authoring_text_jobs WHERE reservation_id=$1
      AND (status='unknown' OR (status='dispatched' AND deadline_at<=clock_timestamp())) LIMIT 1`,
        [reservationId],
      )
    ).rowCount;
  }
  async settleLiveSpend(
    c: PoolClient,
    sessionId: string,
    reservationId: string,
    actualMicros: number | null,
    code: string,
  ) {
    const session = (
      await c.query(
        'SELECT s.id,s.scope_id FROM live_test_sessions s JOIN generation_budget_reservations r ON r.scope_id=s.scope_id WHERE s.id=$1 AND r.id=$2',
        [sessionId, reservationId],
      )
    ).rows[0];
    if (!session) fail(409, 'LIVE_RESERVATION_MISMATCH', 'LIVE_RESERVATION_MISMATCH');
    await this.lockAuthorization(c, sessionId);
    const overdue = await this.overdueDispatch(c, reservationId);
    if (actualMicros !== null) await settleGenerationSpend(c, reservationId, actualMicros);
    const reserve = (
      await c.query('SELECT upper_micros FROM generation_budget_reservations WHERE id=$1', [
        reservationId,
      ])
    ).rows[0];
    if (
      overdue ||
      actualMicros === null ||
      (!this.release && code === 'PROVIDER_HTTP_403') ||
      code === 'PROVIDER_DEADLINE_EXCEEDED' ||
      code === 'PROVIDER_LIMIT_VIOLATION' ||
      (actualMicros !== null && actualMicros > Number(reserve.upper_micros))
    ) {
      await c.query(
        "UPDATE live_test_sessions SET state='stopped',stop_code=COALESCE(stop_code,$2) WHERE id=$1",
        [sessionId, overdue ? 'PROVIDER_DEADLINE_EXCEEDED' : code],
      );
      await c.query('UPDATE generation_budget_scopes SET blocked=true WHERE id=$1', [
        session.scope_id,
      ]);
    }
  }
  async authorizeImage(
    c: PoolClient,
    userId: string,
    sessionId?: string,
    imageInput?: GenerationRequest,
  ): Promise<ImagePolicy> {
    if (this.release) return this.release.policy(c, userId, sessionId);
    await this.owner(userId);
    const test = await boundedTest(c, sessionId);
    if (test) {
      if (!imageInput) fail(403, 'BOUNDED_TEST_LOCATION_ONLY', 'BOUNDED_TEST_LOCATION_ONLY');
      await this.lockAuthorization(c, test.authorization_id);
      return {
        ...(await boundedPolicy(c, test, userId, this.ownerConfig!, imageInput)),
        verifiedUpperMicros: null,
      };
    }
    const id = await this.resolveAuthorizationId(c, userId, sessionId, 'image');
    const row = (await c.query('SELECT * FROM live_test_sessions WHERE id=$1', [id])).rows[0];
    const scope = (
      await c.query('SELECT * FROM generation_budget_scopes WHERE id=$1', [row.scope_id])
    ).rows[0];
    const retained = this.ownerConfig ? await retainedModelRejectionAdmission(c, row, scope) : null;
    // The grant supplies rights/caps only; an image factory must supply its own cost evidence.
    return {
      ...(await this.effectivePolicy(c)),
      ...(retained?.eligible ? { preserveModelRejectionHolds: true as const } : {}),
      verifiedUpperMicros: null,
      ...(this.ownerConfig
        ? {
            generationMode: 'owner' as const,
            generationAuthorizationId: id,
            generationConfigFingerprint: this.ownerConfig.configFingerprint,
          }
        : {}),
    };
  }
  private async session(
    c: PoolClient,
    sessionId: string,
    userId: string,
    purpose: 'text' | 'image' = 'text',
  ) {
    if (this.release) return this.release.check(c, sessionId, userId);
    if (!this.config.enabled) fail(409, 'LIVE_TEST_DISABLED', 'LIVE_TEST_DISABLED');
    await this.ownerTx(c, userId);
    const s = await this.lockAuthorization(c, sessionId);
    if (!s || s.owner_id !== userId || s.scope_id !== GENERATION_SCOPE_ID)
      fail(403, 'LIVE_SESSION_FORBIDDEN', 'LIVE_SESSION_FORBIDDEN');
    const scope = (
      await c.query('SELECT * FROM generation_budget_scopes WHERE id=$1', [s.scope_id])
    ).rows[0];
    let retained: Awaited<ReturnType<typeof retainedModelRejectionAdmission>> | undefined;
    if (this.ownerConfig) {
      if (
        s.mode !== 'owner' ||
        s.expires_at !== null ||
        s.config_hash !== this.identity() ||
        s.owner_handle !== this.ownerConfig.ownerHandle
      )
        fail(409, 'GENERATION_CONFIG_IMMUTABLE', 'GENERATION_CONFIG_IMMUTABLE');
      await this.assertActivePolicy(c, s.id);
      if (!this.pricingCurrent())
        fail(409, 'GENERATION_PRICING_EXPIRED', 'GENERATION_PRICING_EXPIRED');
      const caps = this.budgetCaps();
      if (
        Number(scope.total_cap_micros) !== Number(s.cap_micros) ||
        Number(scope.text_cap_micros) !== Number(s.text_cap_micros) ||
        Number(scope.image_cap_micros) !== Number(s.image_cap_micros) ||
        Number(s.cap_micros) > caps.totalCapMicros ||
        Number(s.text_cap_micros) > caps.textCapMicros ||
        Number(s.image_cap_micros) > caps.imageCapMicros ||
        !scope.serialize_outstanding
      )
        fail(409, 'GENERATION_CONFIG_IMMUTABLE', 'GENERATION_CONFIG_IMMUTABLE');
      if (purpose === 'image') retained = await retainedModelRejectionAdmission(c, s, scope);
      await this.historicalSafety(c, userId, false, retained?.eligible === true);
    } else {
      if (s.mode !== 'manual' || !s.expires_at || sessionId !== this.config.sessionId)
        fail(403, 'LIVE_SESSION_FORBIDDEN', 'LIVE_SESSION_FORBIDDEN');
      if (
        (
          await c.query("SELECT 1 FROM live_test_sessions WHERE scope_id=$1 AND mode='owner'", [
            GENERATION_SCOPE_ID,
          ])
        ).rowCount
      )
        fail(409, 'GENERATION_MODE_IMMUTABLE', 'GENERATION_MODE_IMMUTABLE');
      if (
        !this.config.expiresAt ||
        new Date(s.expires_at).getTime() !== this.config.expiresAt.getTime()
      )
        fail(409, 'LIVE_GRANT_IMMUTABLE', 'LIVE_GRANT_IMMUTABLE');
      if (new Date(s.expires_at).getTime() <= Date.now())
        fail(409, 'LIVE_TEST_EXPIRED', 'LIVE_TEST_EXPIRED');
    }
    if ((s.state !== 'active' || scope.blocked || !scope.approved) && !retained?.eligible)
      fail(409, 'LIVE_SESSION_STOPPED', 'LIVE_SESSION_STOPPED');
    const unknown = (
      await c.query(
        "SELECT 1 FROM generation_budget_reservations b JOIN image_generation_jobs j ON j.reservation_id=b.id WHERE b.scope_id=$1 AND NOT(b.id=ANY($2::uuid[])) AND j.mode='external' AND NOT EXISTS(SELECT 1 FROM image_generation_recoveries recovery WHERE recovery.job_id=j.id AND recovery.scope_id=b.scope_id AND j.status='rejected' AND b.status='settled' AND recovery.actual_micros=b.actual_micros) AND (j.status='unknown' OR j.safe_diagnostic->>'httpStatus'='403' OR (j.status='dispatched' AND j.dispatch_deadline<=now())) UNION ALL SELECT 1 FROM live_test_text_permits p JOIN live_test_sessions a ON a.id=p.session_id WHERE a.scope_id=$1 AND (p.state='unknown' OR (p.state='dispatched' AND p.dispatched_at<=now()-interval '60 seconds')) LIMIT 1",
        [s.scope_id, retained?.eligible ? retained.reservationIds : []],
      )
    ).rowCount;
    if (unknown) fail(409, 'LIVE_OUTCOME_UNRESOLVED', 'LIVE_OUTCOME_UNRESOLVED');
    if (
      (await c.query("SELECT to_regclass('live_authoring_text_jobs') AS present")).rows[0].present
    ) {
      if (
        (
          await c.query(
            "SELECT 1 FROM live_authoring_text_jobs j JOIN live_test_sessions a ON a.id=j.session_id WHERE a.scope_id=$1 AND (j.status='unknown' OR (j.status='dispatched' AND j.deadline_at<=now())) LIMIT 1",
            [s.scope_id],
          )
        ).rowCount
      )
        fail(409, 'LIVE_OUTCOME_UNRESOLVED', 'LIVE_OUTCOME_UNRESOLVED');
    }
    await this.enableExclusiveScope(c);
    return s;
  }
  private async campaign(c: PoolClient, campaignId: string, userId: string) {
    const row = (
      await c.query(
        `SELECT c.state FROM game_campaigns c JOIN users u ON u.id=c.owner_id WHERE c.id=$1 AND c.owner_id=$2 AND c.status='active' AND u.deleted_at IS NULL AND EXISTS(SELECT 1 FROM game_members m WHERE m.campaign_id=c.id AND m.user_id=$2 AND m.status='accepted') AND ${sourceAccessSql('$2')} FOR SHARE OF c`,
        [campaignId, userId],
      )
    ).rows[0];
    if (!row) fail(403, 'FORBIDDEN', 'FORBIDDEN');
    const turn = row.state.turnController;
    if (!turn || turn.phase !== 'world')
      fail(409, 'LIVE_WORLD_PHASE_REQUIRED', 'LIVE_WORLD_PHASE_REQUIRED');
    return turn;
  }
  async pending(userId: string, campaignId: string) {
    await this.owner(userId);
    z.uuid().parse(campaignId);
    return this.db.tx(async (c) => {
      const turn = await this.campaign(c, campaignId, userId);
      const rows = (
        await c.query(
          "SELECT r.id,r.npc_id,r.purpose,r.context,r.result_code,p.state AS permit_state,EXISTS(SELECT 1 FROM game_story_turns t WHERE t.id::text=r.context->>'storyTurnId' AND t.campaign_id=r.campaign_id AND t.context->'quotedReplies' @> jsonb_build_array(jsonb_build_object('request',jsonb_build_object('id',r.id::text)))) AS composer_bound FROM game_npc_decision_requests r LEFT JOIN live_test_text_permits p ON p.request_id=r.id WHERE r.campaign_id=$1 AND r.status IN ('queued','scheduled') ORDER BY CASE WHEN r.context ? 'turnOrder' THEN (r.context->>'turnOrder')::bigint ELSE 9223372036854775807 END,r.created_at,r.id LIMIT 16",
          [campaignId],
        )
      ).rows;
      let active = this.release
        ? ((
            await c.query("SELECT * FROM live_test_sessions WHERE owner_id=$1 AND mode='release'", [
              userId,
            ])
          ).rows[0] ?? {
            policy_revision: 1,
            policy_hash: this.release.config.configFingerprint,
            config_hash: this.release.config.configFingerprint,
          })
        : this.ownerConfig
          ? (
              await c.query(
                "SELECT policy_revision,policy_hash,config_hash FROM live_test_sessions WHERE scope_id=$1 AND mode='owner'",
                [GENERATION_SCOPE_ID],
              )
            ).rows[0]
          : null;
      if (this.release && active?.id) {
        const scope = (
          await c.query('SELECT * FROM generation_budget_scopes WHERE id=$1', [active.scope_id])
        ).rows[0];
        const projected = await releaseProfileProjection(c, active, scope, this.release.config);
        active = { ...active, policy_revision: projected.revision, policy_hash: projected.hash };
      }
      const countViews = new Map<string, unknown>();
      for (const r of rows) countViews.set(r.id, await this.countView(c, r));
      return {
        turnFence: { roundId: turn.roundId, phaseEpoch: turn.phaseEpoch, rulesetVersion: 1 },
        requests: rows.map((r) => {
          let estimateSnapshot: TextReserveSnapshot | null = null,
            estimateError: string | null = null;
          try {
            estimateSnapshot = this.requestEstimate(r.purpose, r.context);
          } catch {
            estimateError = 'TEXT_CONTEXT_WINDOW_EXCEEDED';
          }
          return {
            id: r.id,
            composerBound: r.composer_bound === true,
            subjectId: r.npc_id,
            purpose: r.purpose,
            errorCode: estimateError ?? r.result_code ?? null,
            automaticKnownCostPolicy: 'known-cost-v1' as const,
            counting: countViews.get(r.id),
            permitState: r.permit_state ?? null,
            upperMicros:
              estimateSnapshot?.costBasis === 'operator_estimate' ? null : this.textUpperMicros(),
            reserveMicros: estimateSnapshot?.reserveMicros ?? this.textUpperMicros(),
            estimateSnapshot,
            configFingerprint: this.profileConfig?.configFingerprint ?? null,
            policyRevision: Number(active?.policy_revision ?? 0),
            policyHash: active?.policy_hash ?? active?.config_hash ?? null,
          };
        }),
      };
    });
  }
  async consent(userId: string, campaignId: string, requestId: string, input: unknown) {
    await this.owner(userId);
    z.uuid().parse(campaignId);
    z.uuid().parse(requestId);
    const v = consentSchema.parse(input);
    return this.db.tx(async (c) => {
      const sessionId = await this.resolveAuthorizationId(
        c,
        userId,
        v.authorizationId ?? v.sessionId,
      );
      const previous = (
        await c.query(
          'SELECT * FROM live_test_text_permits WHERE session_id=$1 AND operation_id=$2',
          [sessionId, v.operationId],
        )
      ).rows[0];
      if (previous) {
        if (previous.request_id !== requestId || previous.campaign_id !== campaignId)
          fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
        const originalQuote = previous.spark_quote_id
          ? (
              await c.query('SELECT price_snapshot FROM spark_quotes WHERE id=$1', [
                previous.spark_quote_id,
              ])
            ).rows[0]
          : undefined;
        if (
          (originalQuote?.price_snapshot?.providerQuote?.automaticKnownCostAcceptance?.policy ===
            'known-cost-v1') !==
          (v.automaticKnownCostPolicy === 'known-cost-v1')
        )
          fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
        return {
          id: previous.id,
          state: previous.state,
          ...(await sparkQuoteView(c, previous.spark_quote_id)),
        };
      }
      if (
        (await c.query('SELECT 1 FROM live_test_text_permits WHERE request_id=$1', [requestId]))
          .rowCount
      )
        fail(409, 'MANUAL_REQUEST_ALREADY_AUTHORIZED', 'MANUAL_REQUEST_ALREADY_AUTHORIZED');
      const turn = await this.campaign(c, campaignId, userId);
      if (
        turn.roundId !== v.turnFence.roundId ||
        turn.phaseEpoch !== v.turnFence.phaseEpoch ||
        turn.ruleset.version !== v.turnFence.rulesetVersion
      )
        fail(409, 'TURN_PHASE_STALE', 'TURN_PHASE_STALE');
      const r = (
        await c.query(
          "SELECT * FROM game_npc_decision_requests WHERE id=$1 AND campaign_id=$2 AND status IN ('queued','scheduled') FOR UPDATE",
          [requestId, campaignId],
        )
      ).rows[0];
      if (r?.context?.budgetExceeded)
        fail(413, 'CONTEXT_BUDGET_EXCEEDED', 'CONTEXT_BUDGET_EXCEEDED');
      if (!r || !['speech', 'plan', 'story_turn', 'narrative'].includes(r.purpose))
        fail(409, 'LIVE_REQUEST_UNAVAILABLE', 'LIVE_REQUEST_UNAVAILABLE');
      if (
        this.release &&
        (
          await c.query(
            `SELECT 1 FROM game_story_turns t WHERE t.id::text=$2 AND t.campaign_id=$3
          AND t.context->'quotedReplies' @> jsonb_build_array(jsonb_build_object('request',jsonb_build_object('id',$1::text)))
         UNION ALL SELECT 1 FROM game_world_generation_batches b WHERE b.campaign_id=$3 AND b.state='accepted'
          AND b.entries @> jsonb_build_array(jsonb_build_object('requestId',$1::text)) LIMIT 1`,
            [requestId, r.context.storyTurnId ?? null, campaignId],
          )
        ).rowCount
      )
        fail(409, 'GENERATION_COMPOSER_CONSENT_REQUIRED', 'GENERATION_COMPOSER_CONSENT_REQUIRED');
      if (
        r.status === 'scheduled' &&
        !(
          await c.query(
            "SELECT 1 FROM npc_ai_jobs WHERE id=$1 AND status='reserved' AND NOT cancel_requested",
            [r.job_id],
          )
        ).rowCount
      )
        fail(409, 'LIVE_REQUEST_UNAVAILABLE', 'LIVE_REQUEST_UNAVAILABLE');
      if (
        r.context.turnFence?.roundId !== turn.roundId ||
        r.context.turnFence?.phaseEpoch !== turn.phaseEpoch
      )
        fail(409, 'TURN_PHASE_STALE', 'TURN_PHASE_STALE');
      if (r.requester_user_id && r.requester_user_id !== userId)
        fail(403, 'FORBIDDEN', 'FORBIDDEN');
      await this.assertCountEvidence(r.context, c, requestId);
      const estimateSnapshot = this.requestEstimate(r.purpose, r.context);
      const reserveMicros = estimateSnapshot?.reserveMicros ?? this.textUpperMicros();
      const activePolicy = this.profileConfig ? await this.assertActivePolicy(c, sessionId) : null;
      if (
        activePolicy &&
        (v.policyRevision !== activePolicy.revision || v.policyHash !== activePolicy.hash)
      )
        fail(409, 'GENERATION_POLICY_STALE', 'GENERATION_POLICY_STALE');
      if (
        estimateSnapshot?.costBasis === 'operator_estimate' &&
        v.estimateFingerprint !== estimateSnapshot.fingerprint
      )
        fail(409, 'GENERATION_TEXT_RESERVE_STALE', 'GENERATION_TEXT_RESERVE_STALE');
      if (
        (
          await c.query(
            "SELECT 1 FROM generation_text_counts WHERE request_id=$1 AND status='dispatched' LIMIT 1",
            [requestId],
          )
        ).rowCount
      )
        fail(409, 'TEXT_COUNT_IN_PROGRESS', 'TEXT_COUNT_IN_PROGRESS');
      const effectivePolicy = await this.effectivePolicy(c, userId);
      const reservation = await reserveGenerationSpend(
        c,
        this.release && estimateSnapshot?.costBasis === 'operator_estimate'
          ? {
              ...effectivePolicy,
              verifiedUpperMicros: null,
              costBasis: 'approved_estimate',
              estimatedTotalMicros: estimateSnapshot.estimatedTotalMicros,
              operationalReserveMicros: reserveMicros,
            }
          : effectivePolicy,
        userId,
        'text',
        `manual-text:${requestId}`,
        reserveMicros,
      );
      const id = randomUUID();
      const sparkQuoteId = await quoteSparks(
        c,
        {
          ownerId: userId,
          operationId: id,
          sourceKind: 'text',
          sourceId: requestId,
          reserveSubunits: providerMicrosToSparkSubunits(String(reserveMicros)),
          expiresAt: new Date(
            Math.min(Date.now() + 60000, this.config.expiresAt?.getTime() ?? Infinity),
          ).toISOString(),
          tariff: sparkTariff(
            this.textProfile(),
            'openai',
            activePolicy?.hash || 'manual-live-text-v1',
          ),
          providerQuote: {
            automaticKnownCostPolicy: 'known-cost-v1',
            ...(v.automaticKnownCostPolicy === 'known-cost-v1'
              ? {
                  automaticKnownCostAcceptance: {
                    policy: v.automaticKnownCostPolicy,
                    operationId: v.operationId,
                    requestId,
                    campaignId,
                    authorizationId: sessionId,
                    contextHash: digest(r.context),
                  },
                }
              : {}),
            permitId: id,
            requestId,
            contextHash: digest(r.context),
            profile: this.textProfile(),
            estimateSnapshot,
            policy: activePolicy,
          },
        },
        { required: !!this.release },
      );
      await reserveSparks(c, userId, sparkQuoteId, reservation, { required: !!this.release });
      await c.query(
        "INSERT INTO live_test_text_permits(id,session_id,campaign_id,request_id,operation_id,context_hash,round_id,phase_epoch,reservation_id,state,request_snapshot,generation_policy_revision,generation_policy_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'authorized',$10,$11,$12)",
        [
          id,
          sessionId,
          campaignId,
          requestId,
          v.operationId,
          digest(r.context),
          turn.roundId,
          turn.phaseEpoch,
          reservation,
          estimateSnapshot ? JSON.stringify(estimateSnapshot) : null,
          activePolicy?.revision ?? null,
          activePolicy?.hash ?? null,
        ],
      );
      await c.query('UPDATE live_test_text_permits SET spark_quote_id=$2 WHERE id=$1', [
        id,
        sparkQuoteId,
      ]);
      return {
        id,
        state: 'authorized',
        ...(await sparkQuoteView(c, sparkQuoteId)),
        upperMicros: estimateSnapshot?.costBasis === 'operator_estimate' ? null : reserveMicros,
        reserveMicros,
        estimateSnapshot,
      };
    });
  }
  async requestAuthorized(requestId: string, context?: unknown) {
    if (!this.config.enabled) return false;
    try {
      return await this.db.tx(async (c) => {
        const row = (
          await c.query(
            "SELECT p.session_id,p.context_hash,s.owner_id FROM live_test_text_permits p JOIN live_test_sessions s ON s.id=p.session_id WHERE p.request_id=$1 AND p.state='authorized'",
            [requestId],
          )
        ).rows[0];
        if (!row) return false;
        await this.session(c, row.session_id, row.owner_id);
        return context === undefined || row.context_hash === digest(context);
      });
    } catch {
      return false;
    }
  }
  /** Only the owning AI queue may release linked jobs. This path proves no job/dispatch ever existed. */
  async rejectUndispatchedRequest(c: PoolClient, requestId: string, code: string) {
    const source = (
      await c.query('SELECT campaign_id FROM game_npc_decision_requests WHERE id=$1', [requestId])
    ).rows[0];
    if (!source) return false;
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `npc-ai:${source.campaign_id}`,
    ]);
    const initial = (
      await c.query('SELECT session_id FROM live_test_text_permits WHERE request_id=$1', [
        requestId,
      ])
    ).rows[0];
    if (!initial) {
      if (this.release) return false;
      // An active manual session deliberately waits for the owner's consent. Once
      // that immutable grant expires/stops, an entirely unapproved request must
      // not strand the world phase. Do not confuse "no permit" with free cost:
      // serialize with consent, then prove no permit, job or ledger record exists.
      const configuredId = this.ownerConfig
        ? (
            await c.query("SELECT id FROM live_test_sessions WHERE scope_id=$1 AND mode='owner'", [
              GENERATION_SCOPE_ID,
            ])
          ).rows[0]?.id
        : this.config.sessionId;
      if (!configuredId) return false;
      const session = (
        await c.query(
          'SELECT state,expires_at FROM live_test_sessions WHERE id=$1 FOR NO KEY UPDATE',
          [configuredId],
        )
      ).rows[0];
      const expired =
        (this.config.expiresAt?.getTime() ?? Infinity) <= Date.now() ||
        (session?.expires_at && new Date(session.expires_at).getTime() <= Date.now()) ||
        !this.pricingCurrent();
      if (!expired && session?.state !== 'stopped') return false;
      const request = (
        await c.query(
          'SELECT status,job_id FROM game_npc_decision_requests WHERE id=$1 FOR UPDATE',
          [requestId],
        )
      ).rows[0];
      if (!request || request.status !== 'queued' || request.job_id) return false;
      if (
        (await c.query('SELECT 1 FROM live_test_text_permits WHERE request_id=$1', [requestId]))
          .rowCount ||
        (
          await c.query(
            "SELECT 1 FROM npc_ai_jobs WHERE request_meta->>'runtimeRequestId'=$1 OR operation_id=$1::uuid LIMIT 1",
            [requestId],
          )
        ).rowCount ||
        (
          await c.query(
            'SELECT 1 FROM generation_budget_reservations WHERE operation_key=$1 LIMIT 1',
            [`manual-text:${requestId}`],
          )
        ).rowCount
      )
        return false;
      return true;
    }
    await this.lockAuthorization(c, initial.session_id);
    const permit = (
      await c.query('SELECT * FROM live_test_text_permits WHERE request_id=$1 FOR UPDATE', [
        requestId,
      ])
    ).rows[0];
    if (!permit || permit.state !== 'authorized' || permit.dispatched_at || permit.job_id)
      return false;
    if (
      (
        await c.query(
          "SELECT 1 FROM npc_ai_jobs WHERE request_meta->>'runtimeRequestId'=$1 LIMIT 1",
          [requestId],
        )
      ).rowCount
    )
      return false;
    await settleGenerationSpend(c, permit.reservation_id, 0);
    await settleReservationSparks(c, permit.reservation_id, {
      outcome: 'not_dispatched',
      receiptId: `permit:${permit.id}`,
    });
    await c.query(
      "UPDATE live_test_text_permits SET state='cancelled',completed_at=now(),result_code=$2 WHERE id=$1",
      [permit.id, /^[A-Z0-9_]{1,80}$/.test(code) ? code : 'MANUAL_REQUEST_UNAVAILABLE'],
    );
    return true;
  }
  async canDispatchJob(jobId: string) {
    const rows = await this.db.query('SELECT request_meta FROM npc_ai_jobs WHERE id=$1', [jobId]);
    return (
      !!rows[0]?.request_meta?.runtimeRequestId &&
      this.requestAuthorized(rows[0].request_meta.runtimeRequestId)
    );
  }
  async begin(request: ProviderRequest, snapshot?: TextReserveSnapshot) {
    return this.db.tx(async (c) => {
      const j = (await c.query('SELECT * FROM npc_ai_jobs WHERE id=$1 FOR UPDATE', [request.jobId]))
        .rows[0];
      const rId = j?.request_meta?.runtimeRequestId;
      const peek = (
        await c.query('SELECT session_id FROM live_test_text_permits WHERE request_id=$1', [
          rId ?? null,
        ])
      ).rows[0];
      if (!peek) fail(403, 'MANUAL_LIVE_CONSENT_REQUIRED', 'MANUAL_LIVE_CONSENT_REQUIRED');
      const grant = (
        await c.query('SELECT owner_id FROM live_test_sessions WHERE id=$1', [peek.session_id])
      ).rows[0];
      if (!grant) fail(403, 'MANUAL_LIVE_CONSENT_REQUIRED', 'MANUAL_LIVE_CONSENT_REQUIRED');
      await this.session(c, peek.session_id, grant.owner_id);
      const p = (
        await c.query('SELECT * FROM live_test_text_permits WHERE request_id=$1 FOR UPDATE', [rId])
      ).rows[0];
      if (!p || p.state !== 'authorized')
        fail(403, 'MANUAL_LIVE_CONSENT_REQUIRED', 'MANUAL_LIVE_CONSENT_REQUIRED');
      await this.session(c, p.session_id, grant.owner_id);
      const turn = await this.campaign(c, p.campaign_id, grant.owner_id);
      if (
        turn.roundId !== p.round_id ||
        turn.phaseEpoch !== Number(p.phase_epoch) ||
        digest(request.context) !== p.context_hash
      )
        fail(409, 'TURN_PHASE_STALE', 'TURN_PHASE_STALE');
      await this.assertCountEvidence(request.context, c, rId);
      const storedSnapshot = p.request_snapshot as TextReserveSnapshot | null;
      if (
        (storedSnapshot || snapshot) &&
        (!storedSnapshot || !snapshot || digest(storedSnapshot) !== digest(snapshot))
      )
        fail(409, 'GENERATION_TEXT_RESERVE_STALE', 'GENERATION_TEXT_RESERVE_STALE');
      const active = this.profileConfig ? await this.assertActivePolicy(c, p.session_id) : null;
      if (
        active &&
        (Number(p.generation_policy_revision ?? 0) !== active.revision ||
          (p.generation_policy_hash ?? (active.revision === 0 ? active.hash : null)) !==
            active.hash)
      )
        fail(409, 'GENERATION_POLICY_CHANGED', 'GENERATION_POLICY_CHANGED');
      const reserved = (
        await c.query('SELECT upper_micros FROM generation_budget_reservations WHERE id=$1', [
          p.reservation_id,
        ])
      ).rows[0];
      if (storedSnapshot && Number(reserved?.upper_micros) !== storedSnapshot.reserveMicros)
        fail(409, 'GENERATION_TEXT_RESERVE_STALE', 'GENERATION_TEXT_RESERVE_STALE');
      // A dispatch already begun with no final cost is an unknown liability, never retried.
      const unresolved = (
        await c.query(
          "SELECT id FROM live_test_text_permits WHERE session_id=$1 AND state IN ('dispatched','unknown') LIMIT 1",
          [p.session_id],
        )
      ).rowCount;
      if (unresolved) fail(409, 'LIVE_OUTCOME_UNRESOLVED', 'LIVE_OUTCOME_UNRESOLVED');
      await c.query(
        "UPDATE live_test_text_permits SET state='dispatched',dispatched_at=now(),job_id=$2 WHERE id=$1",
        [p.id, request.jobId],
      );
      return p.id as string;
    });
  }
  async complete(id: string, actual: number | null, code: string, requestId?: string) {
    await this.db.tx(async (c) => {
      const peek = (
        await c.query('SELECT session_id FROM live_test_text_permits WHERE id=$1', [id])
      ).rows[0];
      if (!peek) return;
      await this.lockAuthorization(c, peek.session_id);
      const p = (await c.query('SELECT * FROM live_test_text_permits WHERE id=$1 FOR UPDATE', [id]))
        .rows[0];
      if (!p) return;
      const overdue = await this.overdueDispatch(c, p.reservation_id);
      if (actual !== null) await settleGenerationSpend(c, p.reservation_id, actual);
      if (actual === null || overdue || code !== 'PROVIDER_RESULT')
        await settleReservationSparks(c, p.reservation_id, {
          outcome: actual === null || overdue ? 'unknown' : 'failure_policy_pending',
          receiptId: `permit:${id}`,
        });
      const reserve = (
        await c.query('SELECT upper_micros FROM generation_budget_reservations WHERE id=$1', [
          p.reservation_id,
        ])
      ).rows[0];
      const stop =
        overdue ||
        actual === null ||
        (!this.release && code === 'PROVIDER_HTTP_403') ||
        code === 'PROVIDER_DEADLINE_EXCEEDED' ||
        (actual !== null && actual > Number(reserve.upper_micros));
      if (stop) {
        await c.query(
          "UPDATE live_test_sessions SET state='stopped',stop_code=COALESCE(stop_code,$2) WHERE id=$1",
          [p.session_id, overdue ? 'PROVIDER_DEADLINE_EXCEEDED' : code],
        );
        await c.query(
          'UPDATE generation_budget_scopes SET blocked=true WHERE id=(SELECT scope_id FROM live_test_sessions WHERE id=$1)',
          [p.session_id],
        );
      }
      const erased = p.context_hash === 'erased' || p.result_code === 'DATA_ERASED';
      await c.query(
        'UPDATE live_test_text_permits SET state=$2,completed_at=now(),result_code=$3,provider_request_id=$4 WHERE id=$1',
        [
          id,
          actual === null ? 'unknown' : 'settled',
          erased ? 'DATA_ERASED' : code,
          erased ? null : (requestId ?? null),
        ],
      );
    });
  }
  /** Called only by the NPC semantic finalizer, after its commit decision. */
  async finalizeNpcSparks(
    c: PoolClient,
    jobId: string,
    committed: boolean,
    actualMicros: number | null,
  ) {
    const p = (
      await c.query(
        "SELECT p.* FROM live_test_text_permits p JOIN npc_ai_jobs j ON (j.id=p.job_id OR j.request_meta->>'runtimeRequestId'=p.request_id::text) WHERE j.id=$1",
        [jobId],
      )
    ).rows[0];
    if (!p) return;
    // Preserve provider -> authorization/scope -> admission fence -> wallet order.
    let authorization;
    if (!committed && actualMicros !== null) {
      const job = (await c.query('SELECT provider_id FROM npc_ai_jobs WHERE id=$1', [jobId]))
        .rows[0];
      if (job)
        await c.query(
          'SELECT provider_id FROM npc_ai_provider_budgets WHERE provider_id=$1 FOR UPDATE',
          [job.provider_id],
        );
      authorization = await this.lockAuthorization(c, p.session_id);
    }
    await settleReservationSparks(
      c,
      p.reservation_id,
      committed && actualMicros !== null
        ? {
            outcome: 'success',
            actualMicros: String(actualMicros),
            evidence: 'configured_rates',
            receiptId: `permit:${p.id}`,
          }
        : {
            outcome: actualMicros === null ? 'unknown' : 'failure_policy_pending',
            receiptId: `permit:${p.id}`,
          },
    );
    if (authorization) await settleKnownPermit(c, p, authorization, true);
  }
  async settleJob(c: PoolClient, jobId: string, actual: number | null, unknown: boolean) {
    const peek = (
      await c.query(
        "SELECT p.id,p.session_id FROM live_test_text_permits p JOIN npc_ai_jobs j ON (j.id=p.job_id OR j.request_meta->>'runtimeRequestId'=p.request_id::text) WHERE j.id=$1",
        [jobId],
      )
    ).rows[0];
    if (!peek) return;
    await this.lockAuthorization(c, peek.session_id);
    const p = (
      await c.query('SELECT * FROM live_test_text_permits WHERE id=$1 FOR UPDATE', [peek.id])
    ).rows[0];
    if (p.state === 'authorized' && actual === 0 && !unknown) {
      await settleGenerationSpend(c, p.reservation_id, 0);
      await settleReservationSparks(c, p.reservation_id, {
        outcome: 'not_dispatched',
        receiptId: `permit:${p.id}`,
      });
      await c.query(
        "UPDATE live_test_text_permits SET state='cancelled',completed_at=now(),result_code='UNDISPATCHED_OR_CACHE' WHERE id=$1",
        [p.id],
      );
    } else if (p.state === 'unknown' && !unknown && actual !== null) {
      await settleGenerationSpend(c, p.reservation_id, actual);
      await c.query(
        "UPDATE live_test_text_permits SET state='settled',completed_at=now(),result_code=CASE WHEN context_hash='erased' OR result_code='DATA_ERASED' THEN 'DATA_ERASED' ELSE 'LATE_COST_RECONCILED' END WHERE id=$1",
        [p.id],
      );
    } else if (p.state === 'dispatched' && unknown) {
      await settleReservationSparks(c, p.reservation_id, {
        outcome: 'unknown',
        receiptId: `permit:${p.id}`,
      });
      await c.query(
        "UPDATE live_test_text_permits SET state='unknown',result_code='PROVIDER_OUTCOME_UNKNOWN' WHERE id=$1",
        [p.id],
      );
      await c.query(
        "UPDATE live_test_sessions SET state='stopped',stop_code='PROVIDER_OUTCOME_UNKNOWN' WHERE id=$1",
        [peek.session_id],
      );
      await c.query(
        'UPDATE generation_budget_scopes SET blocked=true WHERE id=(SELECT scope_id FROM live_test_sessions WHERE id=$1)',
        [peek.session_id],
      );
    }
  }

  /** Caller holds authorization+scope rows, OR its provider-budget row+shared admission fence.
   * This check only reads; it never acquires either lock set or another financial scope. */
  async assertActivePolicy(c: PoolClient, authorizationId?: string, expectedFingerprint?: string) {
    if (this.release) return this.release.active(c, authorizationId, expectedFingerprint);
    if (!this.ownerConfig) return { revision: 0, hash: '', configFingerprint: '' };
    const test = await boundedTest(c, authorizationId);
    if (test) {
      if (expectedFingerprint && expectedFingerprint !== this.ownerConfig.configFingerprint)
        fail(409, 'GENERATION_POLICY_CHANGED', 'GENERATION_POLICY_CHANGED');
      await boundedPolicy(c, test, test.owner_id, this.ownerConfig);
      return {
        revision: 1,
        hash: test.policy_hash,
        configFingerprint: this.ownerConfig.configFingerprint,
      };
    }
    const row = (
      await c.query("SELECT * FROM live_test_sessions WHERE scope_id=$1 AND mode='owner'", [
        GENERATION_SCOPE_ID,
      ])
    ).rows[0];
    if (!row || (authorizationId && row.id !== authorizationId))
      fail(409, 'GENERATION_CONSENT_REQUIRED', 'GENERATION_CONSENT_REQUIRED');
    // The already-held target financial row serializes amendments; do not take the
    // cross-scope admission lock here before callers finish their campaign/source locks.
    const hash = this.identity()!;
    if (
      row.config_hash !== hash ||
      (row.policy_hash !== null && row.policy_hash !== hash) ||
      (expectedFingerprint && expectedFingerprint !== this.ownerConfig.configFingerprint)
    )
      fail(409, 'GENERATION_POLICY_CHANGED', 'GENERATION_POLICY_CHANGED');
    if (Number(row.policy_revision) > 0) {
      const revision = (
        await c.query(
          'SELECT profile_hash,config_fingerprint FROM generation_policy_revisions WHERE authorization_id=$1 AND revision=$2',
          [row.id, row.policy_revision],
        )
      ).rows[0];
      if (
        !revision ||
        revision.profile_hash !== hash ||
        revision.config_fingerprint !== this.ownerConfig.configFingerprint
      )
        fail(409, 'GENERATION_POLICY_CHANGED', 'GENERATION_POLICY_CHANGED');
    }
    return {
      revision: Number(row.policy_revision),
      hash,
      configFingerprint: this.ownerConfig.configFingerprint,
    };
  }

  /**
   * Queue-only read under the caller's locked NPC provider-budget row AND shared admission fence.
   * Never locks an authorization/scope or takes another advisory lock under that fence.
   * An operator candidate is not an accepted cap until its persisted revision matches.
   */
  async acknowledgedTextCap(c: PoolClient, authorizationId: string): Promise<number | null> {
    if (this.release) {
      await this.release.active(c, authorizationId);
      return this.release.config.aggregateCapMicros;
    }
    const cfg = this.ownerConfig;
    if (!cfg || !this.config.enabled)
      return fail(409, 'GENERATION_OWNER_MODE_REQUIRED', 'GENERATION_OWNER_MODE_REQUIRED');
    const row = (
      await c.query(
        `SELECT s.*,b.approved AS scope_approved,b.blocked AS scope_blocked,
        b.text_cap_micros AS scope_text_cap,u.handle AS current_handle,u.deleted_at AS owner_deleted_at
       FROM live_test_sessions s JOIN generation_budget_scopes b ON b.id=s.scope_id
       JOIN users u ON u.id=s.owner_id WHERE s.id=$1 AND s.scope_id=$2 AND s.mode='owner'`,
        [authorizationId, GENERATION_SCOPE_ID],
      )
    ).rows[0];
    if (!row) fail(409, 'GENERATION_CONSENT_REQUIRED', 'GENERATION_CONSENT_REQUIRED');
    if (
      row.owner_deleted_at ||
      row.owner_handle !== cfg.ownerHandle ||
      row.current_handle !== cfg.ownerHandle
    )
      fail(403, 'GENERATION_OWNER_IMMUTABLE', 'GENERATION_OWNER_IMMUTABLE');
    if (row.state !== 'active' || row.stop_code || !row.scope_approved || row.scope_blocked)
      fail(409, 'LIVE_SESSION_STOPPED', 'LIVE_SESSION_STOPPED');
    if (!this.pricingCurrent())
      fail(409, 'GENERATION_PRICING_EXPIRED', 'GENERATION_PRICING_EXPIRED');
    await this.assertActivePolicy(c, authorizationId, cfg.configFingerprint);
    await this.historicalSafety(c, row.owner_id);
    if ((await policyWorkBlockers(c, GENERATION_SCOPE_ID)).includes('LIVE_OUTCOME_UNRESOLVED'))
      fail(409, 'LIVE_OUTCOME_UNRESOLVED', 'LIVE_OUTCOME_UNRESOLVED');
    const caps = [Number(row.text_cap_micros), Number(row.scope_text_cap), cfg.textCapMicros];
    if (caps.some((n) => !Number.isSafeInteger(n) || n <= 0))
      fail(409, 'GENERATION_CONFIG_IMMUTABLE', 'GENERATION_CONFIG_IMMUTABLE');
    return Math.min(...caps);
  }
  async reviewPolicy(userId: string) {
    if (this.release) fail(403, 'OPERATOR_ONLY', 'OPERATOR_ONLY');
    await this.owner(userId);
    return this.db.tx(async (c) => {
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const row = (
        await c.query("SELECT * FROM live_test_sessions WHERE scope_id=$1 AND mode='owner'", [
          GENERATION_SCOPE_ID,
        ])
      ).rows[0];
      if (row && row.owner_id !== userId)
        fail(403, 'GENERATION_OWNER_IMMUTABLE', 'GENERATION_OWNER_IMMUTABLE');
      const scope = (
        await c.query('SELECT * FROM generation_budget_scopes WHERE id=$1', [GENERATION_SCOPE_ID])
      ).rows[0];
      const historyRows = row
        ? (
            await c.query(
              'SELECT * FROM generation_policy_revisions WHERE authorization_id=$1 ORDER BY revision',
              [row.id],
            )
          ).rows
        : [];
      const saved = historyRows.find((r) => Number(r.revision) === Number(row?.policy_revision));
      const matches = !!row && !!this.ownerConfig && row.config_hash === this.identity();
      const legacy = !!row && Number(row.policy_revision) === 0;
      const profile =
        saved?.profile_snapshot ??
        (legacy && matches && this.ownerConfig
          ? safeOwnerProfile({
              ...this.ownerConfig,
              totalCapMicros: Number(row.cap_micros),
              textCapMicros: Number(row.text_cap_micros),
              imageCapMicros: Number(row.image_cap_micros),
            })
          : null);
      const active = row
        ? {
            revision: Number(row.policy_revision),
            hash: row.policy_hash ?? row.config_hash,
            configFingerprint:
              saved?.config_fingerprint ??
              (matches ? (this.profileConfig?.configFingerprint ?? null) : null),
            profile,
            acknowledgedAt: saved ? new Date(saved.acknowledged_at).toISOString() : null,
            legacy,
          }
        : null;
      const liabilities = await policyLiabilities(c, GENERATION_SCOPE_ID);
      const blockers: string[] = [];
      if (!this.ownerConfig) blockers.push('GENERATION_OWNER_MODE_REQUIRED');
      if (!row) blockers.push('GENERATION_CONSENT_REQUIRED');
      if (row && this.ownerConfig && row.owner_handle !== this.ownerConfig.ownerHandle)
        blockers.push('GENERATION_OWNER_IMMUTABLE');
      if (
        row &&
        scope &&
        (Number(row.cap_micros) !== Number(scope.total_cap_micros) ||
          Number(row.text_cap_micros) !== Number(scope.text_cap_micros) ||
          Number(row.image_cap_micros) !== Number(scope.image_cap_micros) ||
          !scope.serialize_outstanding)
      )
        blockers.push('GENERATION_CONFIG_IMMUTABLE');
      if (row && (row.state !== 'active' || !scope?.approved || scope?.blocked))
        blockers.push('LIVE_SESSION_STOPPED');
      if (!this.pricingCurrent()) blockers.push('GENERATION_PRICING_EXPIRED');
      if (
        row &&
        Number(row.policy_revision) > 0 &&
        (!saved || saved.profile_hash !== row.config_hash || row.policy_hash !== row.config_hash)
      )
        blockers.push('GENERATION_POLICY_CHANGED');
      try {
        await this.historicalSafety(c, userId, !row);
      } catch (e) {
        const code = e instanceof Error ? e.message : 'GENERATION_PRIOR_LIABILITY_UNRESOLVED';
        blockers.push(
          /^[A-Z0-9_]{1,100}$/.test(code) ? code : 'GENERATION_PRIOR_LIABILITY_UNRESOLVED',
        );
      }
      const work = await policyWorkBlockers(c, GENERATION_SCOPE_ID);
      const dispatchBlockers = [
        ...blockers,
        ...work.filter((code) => code !== 'GENERATION_POLICY_BUSY'),
      ];
      if (row && !matches) dispatchBlockers.push('GENERATION_POLICY_REVIEW_REQUIRED');
      const candidate = this.ownerConfig ? safeOwnerProfile(this.ownerConfig) : null;
      const amendmentBlockers = [...blockers, ...work];
      if (
        this.ownerConfig &&
        (liabilities.totalAccountedMicros > this.ownerConfig.totalCapMicros ||
          liabilities.text.spentMicros + liabilities.text.heldMicros >
            this.ownerConfig.textCapMicros ||
          liabilities.image.spentMicros + liabilities.image.heldMicros >
            this.ownerConfig.imageCapMicros)
      )
        amendmentBlockers.push('GENERATION_CAP_BELOW_HISTORICAL_SPEND');
      const proposed =
        this.ownerConfig && row && (!matches || !profile || digest(profile) !== digest(candidate))
          ? {
              candidateFingerprint: this.ownerConfig.configFingerprint,
              hash: this.identity()!,
              profile: candidate!,
              canApply: amendmentBlockers.length === 0,
              blockers: [...new Set(amendmentBlockers)],
            }
          : null;
      return {
        mode: this.mode,
        authorizationId: row?.id ?? null,
        scopeId: GENERATION_SCOPE_ID,
        active,
        proposed,
        history: historyRows.map((r) => ({
          revision: Number(r.revision),
          hash: r.profile_hash,
          previousHash: r.previous_hash,
          configFingerprint: r.config_fingerprint,
          acknowledgedAt: new Date(r.acknowledged_at).toISOString(),
          operationId: r.operation_id,
          profile: r.profile_snapshot,
        })),
        liabilities,
        dispatchEnabled: !!row && dispatchBlockers.length === 0,
        blockers: [...new Set(dispatchBlockers)],
        legacyProfileStatus: !row
          ? ('unclaimed' as const)
          : profile
            ? ('available' as const)
            : ('unavailable' as const),
      };
    });
  }
  async policyOperation(userId: string, operationId: string) {
    await this.owner(userId);
    z.uuid().parse(operationId);
    const row = (
      await this.db.query(
        "SELECT r.* FROM generation_policy_revisions r JOIN live_test_sessions s ON s.id=r.authorization_id WHERE s.owner_id=$1 AND s.scope_id=$2 AND s.mode='owner' AND r.operation_id=$3",
        [userId, GENERATION_SCOPE_ID, operationId],
      )
    )[0];
    return row ? revisionReceipt(row) : { operationId, status: 'not_found' as const };
  }
  async amendPolicy(userId: string, input: unknown) {
    if (this.release) fail(403, 'OPERATOR_ONLY', 'OPERATOR_ONLY');
    await this.owner(userId);
    if (!this.ownerConfig)
      fail(409, 'GENERATION_OWNER_MODE_REQUIRED', 'GENERATION_OWNER_MODE_REQUIRED');
    const body = z
      .object({
        operationId: z.uuid(),
        expectedRevision: z.number().int().nonnegative(),
        expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
        candidateFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        consent: z.literal(true),
      })
      .strict()
      .parse(input);
    const requestHash = policyRequestHash(body);
    return this.db.tx(async (c) => {
      await this.ownerTx(c, userId);
      const peek = (
        await c.query("SELECT id FROM live_test_sessions WHERE scope_id=$1 AND mode='owner'", [
          GENERATION_SCOPE_ID,
        ])
      ).rows[0];
      if (!peek) fail(409, 'GENERATION_CONSENT_REQUIRED', 'GENERATION_CONSENT_REQUIRED');
      const row = await this.lockAuthorization(c, peek.id);
      if (!row || row.owner_id !== userId || row.owner_handle !== this.ownerConfig!.ownerHandle)
        fail(403, 'GENERATION_OWNER_IMMUTABLE', 'GENERATION_OWNER_IMMUTABLE');
      // Reconcile an exact receipt before CAS, including a late first request after an uncertain response.
      const previous = (
        await c.query(
          'SELECT * FROM generation_policy_revisions WHERE authorization_id=$1 AND operation_id=$2',
          [row.id, body.operationId],
        )
      ).rows[0];
      if (previous) {
        if (previous.request_hash !== requestHash)
          fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
        return revisionReceipt(previous);
      }
      if (
        Number(row.policy_revision) !== body.expectedRevision ||
        (row.policy_hash ?? row.config_hash) !== body.expectedHash ||
        body.candidateFingerprint !== this.ownerConfig!.configFingerprint
      )
        fail(409, 'GENERATION_POLICY_STALE', 'GENERATION_POLICY_STALE');
      await fenceGenerationAdmission(c);
      const scope = (
        await c.query('SELECT * FROM generation_budget_scopes WHERE id=$1', [GENERATION_SCOPE_ID])
      ).rows[0];
      if (row.state !== 'active' || scope?.blocked || !scope?.approved)
        fail(409, 'LIVE_SESSION_STOPPED', 'LIVE_SESSION_STOPPED');
      if (!this.pricingCurrent())
        fail(409, 'GENERATION_PRICING_EXPIRED', 'GENERATION_PRICING_EXPIRED');
      await this.historicalSafety(c, userId);
      const work = await policyWorkBlockers(c, GENERATION_SCOPE_ID);
      if (work.length) fail(409, work[0], work[0]);
      const liabilities = await policyLiabilities(c, GENERATION_SCOPE_ID);
      const cfg = this.ownerConfig!;
      if (
        liabilities.totalAccountedMicros > cfg.totalCapMicros ||
        liabilities.text.spentMicros + liabilities.text.heldMicros > cfg.textCapMicros ||
        liabilities.image.spentMicros + liabilities.image.heldMicros > cfg.imageCapMicros
      )
        fail(409, 'GENERATION_CAP_BELOW_HISTORICAL_SPEND', 'GENERATION_CAP_BELOW_HISTORICAL_SPEND');
      // No spend, hold, blocked flag, stop code, owner or scope is replaced.
      await c.query(
        'UPDATE generation_budget_scopes SET total_cap_micros=$2,text_cap_micros=$3,image_cap_micros=$4 WHERE id=$1',
        [GENERATION_SCOPE_ID, cfg.totalCapMicros, cfg.textCapMicros, cfg.imageCapMicros],
      );
      await c.query(
        'UPDATE live_test_sessions SET config_hash=$2,cap_micros=$3,text_cap_micros=$4,image_cap_micros=$5 WHERE id=$1',
        [row.id, this.identity(), cfg.totalCapMicros, cfg.textCapMicros, cfg.imageCapMicros],
      );
      const revision = await appendPolicyRevision(c, {
        authorizationId: row.id,
        scopeId: GENERATION_SCOPE_ID,
        revision: Number(row.policy_revision) + 1,
        hash: this.identity()!,
        previousHash: row.policy_hash ?? row.config_hash,
        config: cfg,
        operationId: body.operationId,
        requestHash,
      });
      return revisionReceipt(revision);
    });
  }
  private async releaseStatus(userId: string) {
    const cfg = this.release!.config;
    return this.db.tx(async (c) => {
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await this.release!.actor(c, userId);
      const row = (
        await c.query(
          "SELECT s.*,b.approved,b.blocked FROM live_test_sessions s JOIN generation_budget_scopes b ON b.id=s.scope_id WHERE s.owner_id=$1 AND s.mode='release'",
          [userId],
        )
      ).rows[0];
      const wallet = (
        await c.query(
          'SELECT enabled,balance_subunits,held_subunits FROM spark_wallets WHERE owner_id=$1',
          [userId],
        )
      ).rows[0];
      const usage = (
        await c.query(
          "SELECT COALESCE(sum(CASE WHEN status='held' THEN upper_micros WHEN status='settled' THEN actual_micros ELSE 0 END),0) used,COALESCE(sum(CASE WHEN status='held' THEN upper_micros ELSE 0 END),0) held,COALESCE(sum(CASE WHEN kind='text' THEN CASE WHEN status='held' THEN upper_micros WHEN status='settled' THEN actual_micros ELSE 0 END ELSE 0 END),0) text,COALESCE(sum(CASE WHEN kind='image' THEN CASE WHEN status='held' THEN upper_micros WHEN status='settled' THEN actual_micros ELSE 0 END ELSE 0 END),0) image FROM generation_budget_reservations WHERE scope_id=$1",
          [releaseScope(userId)],
        )
      ).rows[0];
      const dreams = (
        await c.query(
          'SELECT enabled,balance_subunits,held_subunits FROM dream_wallets WHERE owner_id=$1',
          [userId],
        )
      ).rows[0];
      const dreamAvailable = dreams?.enabled
        ? BigInt(dreams.balance_subunits) - BigInt(dreams.held_subunits)
        : 0n;
      const sparkAvailable = wallet?.enabled
        ? BigInt(wallet.balance_subunits) - BigInt(wallet.held_subunits)
        : 0n;
      // Status is advisory; authoritative reservations stay exact bigint under wallet locks.
      const available = Number(
        dreamAvailable + sparkAvailable > BigInt(Number.MAX_SAFE_INTEGER)
          ? BigInt(Number.MAX_SAFE_INTEGER)
          : dreamAvailable + sparkAvailable,
      );
      const exposure = await aggregateGenerationExposure(c);
      const aggregateRemaining =
        cfg.aggregateCapMicros === null
          ? available
          : Math.max(0, cfg.aggregateCapMicros - Number(exposure.totalMicros));
      const current =
        ownerPricingIsCurrent(cfg.text.pricing) && ownerPricingIsCurrent(cfg.image.pricing);
      let projected = { revision: Number(row?.policy_revision ?? 1), hash: cfg.configFingerprint };
      let profileError: string | null = null;
      try {
        await currentReleaseDeployment(c, cfg);
      } catch {
        profileError = 'GENERATION_RELEASE_PROFILE_NOT_ACTIVE';
      }
      if (row && !profileError) {
        const scope = (
          await c.query('SELECT * FROM generation_budget_scopes WHERE id=$1', [row.scope_id])
        ).rows[0];
        try {
          projected = await releaseProfileProjection(c, row, scope, cfg);
        } catch (error) {
          const response = (error as { getResponse?: () => { code?: string } }).getResponse?.();
          profileError = response?.code ?? 'GENERATION_POLICY_CHANGED';
        }
      }
      const stopCode = !current
        ? 'GENERATION_PRICING_EXPIRED'
        : wallet?.enabled !== true
          ? 'SPARK_WALLET_NOT_ENABLED'
          : available <= 0
            ? 'INSUFFICIENT_SPARKS'
            : aggregateRemaining <= 0
              ? 'GENERATION_AGGREGATE_BUDGET_EXCEEDED'
              : row && (row.state !== 'active' || row.blocked || !row.approved)
                ? 'GENERATION_ACCOUNT_REVIEW_REQUIRED'
                : profileError;
      const cap =
        cfg.totalCapMicros === null
          ? null
          : Math.min(cfg.totalCapMicros, Number(row?.cap_micros ?? cfg.totalCapMicros));
      return {
        ownerId: userId,
        mode: 'release' as const,
        dreamsAvailableSubunits: dreamAvailable.toString(),
        sparksAvailableSubunits: sparkAvailable.toString(),
        ...(cfg.allowance ? { allowance: cfg.allowance } : {}),
        enabled: true,
        authorizationId: row?.id ?? null,
        sessionId: row?.id ?? null,
        state: stopCode ? ('stopped' as const) : ('active' as const),
        expiresAt: null,
        pricingValidUntil:
          cfg.text.pricing.validUntil < cfg.image.pricing.validUntil
            ? cfg.text.pricing.validUntil
            : cfg.image.pricing.validUntil,
        stopCode,
        capMicros: cap,
        textCapMicros: cfg.textCapMicros,
        imageCapMicros: cfg.imageCapMicros,
        usedMicros: Number(usage.used),
        heldMicros: Number(usage.held),
        textUsedMicros: Number(usage.text),
        imageUsedMicros: Number(usage.image),
        remainingMicros: Math.max(
          0,
          Math.min(
            cap === null ? available : cap - Number(usage.used),
            available,
            aggregateRemaining,
          ),
        ),
        textRemainingMicros: Math.max(
          0,
          Math.min(
            cfg.textCapMicros === null ? available : cfg.textCapMicros - Number(usage.text),
            available,
            aggregateRemaining,
          ),
        ),
        imageRemainingMicros: Math.max(
          0,
          Math.min(
            cfg.imageCapMicros === null ? available : cfg.imageCapMicros - Number(usage.image),
            available,
            aggregateRemaining,
          ),
        ),
        priorHeldReservations: 0,
        policyRevision: projected.revision,
        policyHash: projected.hash,
        configFingerprint: cfg.configFingerprint,
        activeConfigFingerprint: row?.config_hash ?? cfg.configFingerprint,
        text: { ...cfg.text, costEvidence: 'operator_estimate', reasoningEffort: 'none' },
      };
    });
  }
  async status(userId: string) {
    if (this.release) return this.releaseStatus(userId);
    await this.owner(userId);
    if (this.ownerConfig) return this.ownerStatus(userId);
    const rows = await this.db.query(
      'SELECT * FROM live_test_sessions WHERE id=$1 AND owner_id=$2',
      [this.config.sessionId, userId],
    );
    const usage = (
      await this.db.query(
        "SELECT COALESCE(sum(CASE WHEN status='held' THEN upper_micros WHEN status='settled' THEN actual_micros ELSE 0 END),0) AS used,COALESCE(sum(CASE WHEN status='held' THEN upper_micros ELSE 0 END),0) AS held FROM generation_budget_reservations WHERE scope_id=$1",
        [GENERATION_SCOPE_ID],
      )
    )[0];
    const prior = (
      await this.db.query(
        "SELECT count(*) AS unknown FROM generation_budget_reservations WHERE scope_id<>$1 AND status='held'",
        [GENERATION_SCOPE_ID],
      )
    )[0];
    const expired = !this.config.expiresAt || this.config.expiresAt.getTime() <= Date.now();
    let unsafe =
      (
        await this.db.query(
          "SELECT 1 FROM generation_budget_reservations b JOIN image_generation_jobs j ON j.reservation_id=b.id WHERE b.scope_id=$1 AND j.mode='external' AND NOT EXISTS(SELECT 1 FROM image_generation_recoveries recovery WHERE recovery.job_id=j.id AND recovery.scope_id=b.scope_id AND j.status='rejected' AND b.status='settled' AND recovery.actual_micros=b.actual_micros) AND (j.status='unknown' OR j.safe_diagnostic->>'httpStatus'='403' OR (j.status='dispatched' AND j.dispatch_deadline<=now())) UNION ALL SELECT 1 FROM live_test_text_permits p WHERE p.session_id=$2 AND (p.state='unknown' OR (p.state='dispatched' AND p.dispatched_at<=now()-interval '60 seconds')) LIMIT 1",
          [GENERATION_SCOPE_ID, this.config.sessionId],
        )
      ).length > 0;
    if (
      (await this.db.query("SELECT to_regclass('live_authoring_text_jobs') AS present"))[0].present
    ) {
      const authoringUnknown = await this.db.query(
        "SELECT 1 FROM live_authoring_text_jobs WHERE session_id=$1 AND (status='unknown' OR (status='dispatched' AND deadline_at<=now())) LIMIT 1",
        [this.config.sessionId],
      );
      unsafe = unsafe || authoringUnknown.length > 0;
    }
    return {
      mode: 'manual' as const,
      authorizationId: this.config.sessionId,
      pricingValidUntil: null,
      enabled: !expired,
      sessionId: this.config.sessionId,
      state: expired || unsafe ? 'stopped' : (rows[0]?.state ?? 'unclaimed'),
      expiresAt: this.config.expiresAt?.toISOString() ?? null,
      stopCode:
        rows[0]?.stop_code ??
        (expired ? 'LIVE_TEST_EXPIRED' : unsafe ? 'LIVE_OUTCOME_UNRESOLVED' : null),
      capMicros: LIVE_TEXT.capMicros,
      usedMicros: Number(usage.used),
      heldMicros: Number(usage.held),
      remainingMicros: Math.max(0, LIVE_TEXT.capMicros - Number(usage.used)),
      priorHeldReservations: Number(prior.unknown),
      text: {
        ...LIVE_TEXT,
        costEvidence: 'conservative_configured_rates',
        reasoningEffort: 'none',
        serviceTier: 'default',
        tools: [],
        store: false,
      },
      imagesEnabled: false,
      imageBlockCode: 'VERIFIED_IMAGE_UPPER_BOUND_REQUIRED',
    };
  }
  private async imageOnlyAdmissionStatus(userId: string) {
    const denied = {
      imageOnlyAdmission: false,
      retainedImageHoldMicros: 0,
      imageActiveHeldMicros: 0,
    };
    if (!this.ownerConfig || !this.pricingCurrent()) return denied;
    return this.db.tx(async (c) => {
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const row = (
        await c.query(
          "SELECT * FROM live_test_sessions WHERE scope_id=$1 AND mode='owner' AND owner_id=$2",
          [GENERATION_SCOPE_ID, userId],
        )
      ).rows[0];
      const scope = (
        await c.query('SELECT * FROM generation_budget_scopes WHERE id=$1', [GENERATION_SCOPE_ID])
      ).rows[0];
      if (
        !row ||
        row.config_hash !== this.identity() ||
        row.owner_handle !== this.ownerConfig!.ownerHandle ||
        !scope ||
        Number(scope.total_cap_micros) !== Number(row.cap_micros) ||
        Number(scope.image_cap_micros) !== Number(row.image_cap_micros) ||
        Number(scope.text_cap_micros) !== Number(row.text_cap_micros)
      )
        return denied;
      try {
        await this.assertActivePolicy(c, row.id);
        const admission = await retainedModelRejectionAdmission(c, row, scope);
        if (!admission.eligible) return denied;
        await this.historicalSafety(c, userId, false, true);
        return {
          imageOnlyAdmission: true,
          retainedImageHoldMicros: admission.retainedMicros,
          imageActiveHeldMicros: admission.activeHeldMicros,
        };
      } catch {
        return denied;
      }
    });
  }
  private async ownerStatus(userId: string) {
    const cfg = this.ownerConfig!;
    const row = (
      await this.db.query("SELECT * FROM live_test_sessions WHERE scope_id=$1 AND mode='owner'", [
        GENERATION_SCOPE_ID,
      ])
    )[0];
    const scope = (
      await this.db.query(
        'SELECT approved,total_cap_micros,text_cap_micros,image_cap_micros FROM generation_budget_scopes WHERE id=$1',
        [GENERATION_SCOPE_ID],
      )
    )[0];
    const effectiveCap = Number(row?.cap_micros ?? scope?.total_cap_micros ?? cfg.totalCapMicros);
    const effectiveTextCap = Number(
      row?.text_cap_micros ?? scope?.text_cap_micros ?? cfg.textCapMicros,
    );
    const effectiveImageCap = Number(
      row?.image_cap_micros ?? scope?.image_cap_micros ?? cfg.imageCapMicros,
    );
    const usage = (
      await this.db.query(
        "SELECT COALESCE(sum(CASE WHEN status='held' THEN upper_micros WHEN status='settled' THEN actual_micros ELSE 0 END),0) used,COALESCE(sum(CASE WHEN status='held' THEN upper_micros ELSE 0 END),0) held,COALESCE(sum(CASE WHEN kind='text' THEN CASE WHEN status='held' THEN upper_micros WHEN status='settled' THEN actual_micros ELSE 0 END ELSE 0 END),0) text_used,COALESCE(sum(CASE WHEN kind='image' THEN CASE WHEN status='held' THEN upper_micros WHEN status='settled' THEN actual_micros ELSE 0 END ELSE 0 END),0) image_used FROM generation_budget_reservations WHERE scope_id=$1",
        [GENERATION_SCOPE_ID],
      )
    )[0];
    const policy = await this.reviewPolicy(userId);
    const stopCode =
      row?.stop_code ??
      policy.blockers.find((code) => code !== 'GENERATION_CONSENT_REQUIRED') ??
      null;
    return {
      ...(await this.imageOnlyAdmissionStatus(userId)),
      mode: 'owner' as const,
      enabled: true,
      policyRevision: policy.active?.revision ?? 0,
      policyHash: policy.active?.hash ?? null,
      configFingerprint: cfg.configFingerprint,
      activeConfigFingerprint: policy.active?.configFingerprint ?? null,
      dispatchEnabled: policy.dispatchEnabled,
      authorizationId: row?.id ?? null,
      sessionId: row?.id ?? null,
      expiresAt: null,
      pricingValidUntil: new Date(
        Math.min(Date.parse(cfg.text.pricing.validUntil), Date.parse(cfg.image.pricing.validUntil)),
      ).toISOString(),
      state: stopCode ? 'stopped' : (row?.state ?? 'unclaimed'),
      stopCode,
      capMicros: effectiveCap,
      textCapMicros: effectiveTextCap,
      imageCapMicros: effectiveImageCap,
      textUsedMicros: Number(usage.text_used),
      imageUsedMicros: Number(usage.image_used),
      textRemainingMicros: Math.max(
        0,
        Math.min(effectiveCap - Number(usage.used), effectiveTextCap - Number(usage.text_used)),
      ),
      imageRemainingMicros: Math.max(
        0,
        Math.min(effectiveCap - Number(usage.used), effectiveImageCap - Number(usage.image_used)),
      ),
      usedMicros: Number(usage.used),
      heldMicros: Number(usage.held),
      remainingMicros: Math.max(0, effectiveCap - Number(usage.used)),
      priorHeldReservations: Number(
        (
          await this.db.query(
            "SELECT count(*) n FROM generation_budget_reservations WHERE scope_id<>$1 AND status='held' AND upper_micros>0",
            [GENERATION_SCOPE_ID],
          )
        )[0].n,
      ),
      text: {
        ...cfg.text,
        scopeId: GENERATION_SCOPE_ID,
        capMicros: effectiveTextCap,
        costEvidence: 'conservative_configured_rates',
        reasoningEffort: 'none',
        serviceTier: 'default',
        tools: [],
        store: false,
      },
      imagesEnabled: false,
      imageBlockCode: 'OWNER_IMAGE_CONFIGURATION_REQUIRED',
    };
  }
}

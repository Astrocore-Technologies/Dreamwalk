import { textUsageCostMicros } from '../generation/text-pricing';
import { Inject, Injectable, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Db } from '../db';
import { SparksAccounting, type SparkSettlement } from '../generation/sparks-accounting';
import { sparksEnabled, sparkTariff, settleReservationSparks } from '../generation/sparks-hooks';
import { fenceGenerationAdmission } from '../generation/scope-fence';
import { packNpcContextWindow } from '../game/npc-context-budget';
import type { TextReserveSnapshot } from '../generation/estimates';
import { GenerationAuthority } from '../generation/service';
import { ReleaseGenerationProvider } from '../generation/release-provider';
import { reserveGenerationSpend, settleGenerationSpend } from '../image-generation/budget';
import { ManualLiveProvider } from '../live-test/provider';
import { fail } from '../errors';
import { npcTelemetrySnapshot } from '../game/npc-telemetry';
import { sourceAccessSql, sourceLiveSql } from '../game/playable.service';
import { NpcSponsorship, type SponsorGrant } from './sponsorship';
import { readNpcAiConfiguration } from './config';
import { cacheKey, digest, validateDecisionContext } from './context';
import { MockNpcProvider, validateProviderResult } from './provider';
import {
  ProviderFailure,
  type AiPolicy,
  type AiScope,
  type DecisionContext,
  type NpcProvider,
  type QueueDecision,
  type ReadyDecision,
} from './types';

const defaults: AiPolicy = {
  creditPrice: 0,
  providerUpperMicros: 0,
  providerCapMicros: 0,
  timeoutMs: 8000,
  quoteMs: 60000,
  reservationMs: 600000,
  cacheMs: 600000,
  maxQueuedPerCampaign: 8,
  maxContextBytes: 64000,
  maxResultBytes: 32000,
  externalApproved: false,
  killSwitch: false,
  version: 'npc-ai-v1',
};
interface Job extends QueryResultRow {
  id: string;
  campaign_id: string;
  npc_id: string;
  operation_id: string;
  request_hash: string;
  origin: 'user' | 'system';
  requester_user_id: string | null;
  payer_user_id: string | null;
  purpose: 'plan' | 'summary' | 'speech' | 'intent' | 'supporting_npc' | 'narrative' | 'story_turn';
  sponsor_id: string | null;
  subject_kind: 'npc' | 'player';
  context_hash: string;
  context: DecisionContext;
  proposal: unknown;
  provider_id: string;
  provider_version: string;
  policy_version: string;
  status: string;
  cancel_requested: boolean;
  credits: number;
  spark_hold_id?: string | null;
  generation_authorization_id?: string | null;
  generation_reservation_id?: string | null;
  reservation_status: string;
  reservation_expires_at: Date;
  provider_upper_micros: string;
  request_snapshot: TextReserveSnapshot | null;
  provider_actual_micros: string | null;
  provider_budget_status: string;
  created_at: Date;
  deadline_at: Date | null;
}
const scopeSchema = z
  .object({
    campaignId: z.uuid(),
    npcId: z
      .string()
      .regex(/^[\w-]+$/)
      .max(100),
    origin: z.enum(['user', 'system']),
    subjectKind: z.enum(['npc', 'player']).optional(),
    purpose: z
      .enum(['plan', 'summary', 'speech', 'intent', 'supporting_npc', 'narrative', 'story_turn'])
      .optional(),
    requesterUserId: z.uuid().optional(),
  })
  .strict();
function publicRequestMeta(value: unknown) {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return {
    quoteId: v.quoteId ?? null,
    consent: v.consent ?? false,
    requestKey: v.requestKey ?? '',
    sponsorId: v.sponsorId ?? null,
    runtimeRequestId: v.runtimeRequestId ?? null,
  };
}
export class NpcAiEngine {
  readonly policy: AiPolicy;
  private inFlight = new Set<string>();
  constructor(
    protected db: Db,
    readonly provider: NpcProvider = new MockNpcProvider(),
    policy: Partial<AiPolicy> = {},
  ) {
    this.policy = {
      ...defaults,
      ...policy,
      ...(provider.contextWindow?.()
        ? { maxContextBytes: provider.contextWindow()!.transportLimitBytes }
        : {}),
    };
    for (const value of [this.policy.creditPrice, this.policy.providerUpperMicros])
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('INVALID_AI_BUDGET');
    if (this.policy.providerCapMicros === null) {
      if (
        !(provider instanceof ReleaseGenerationProvider) ||
        provider.session.releaseConfig?.allowance !== 'unlimited'
      )
        throw new Error('INVALID_AI_BUDGET');
    } else if (
      !Number.isSafeInteger(this.policy.providerCapMicros) ||
      this.policy.providerCapMicros < 0
    )
      throw new Error('INVALID_AI_BUDGET');
    if (
      this.policy.timeoutMs < 10 ||
      this.policy.timeoutMs > 60000 ||
      this.policy.maxQueuedPerCampaign < 1 ||
      this.policy.maxQueuedPerCampaign > 64
    )
      throw new Error('INVALID_AI_LIMITS');
  }
  private async excludeLegacyOwnerBypass(c: PoolClient) {
    if (
      !this.provider.external ||
      this.provider instanceof ManualLiveProvider ||
      this.provider instanceof ReleaseGenerationProvider
    )
      return;
    // Caller owns its target provider-budget row before the shared admission fence.
    // No owner/session/shared-scope row is locked here, so owner claim cannot invert locks.
    await fenceGenerationAdmission(c);
    if ((await c.query("SELECT 1 FROM live_test_sessions WHERE mode='owner' LIMIT 1")).rowCount)
      fail(409, 'GENERATION_AUTHORITY_IMMUTABLE', 'GENERATION_AUTHORITY_IMMUTABLE');
  }
  private get sponsorship() {
    return new NpcSponsorship(this.db, this.provider, this.policy, (c, scope) =>
      this.authorize(c, scope),
    );
  }
  grantSponsor(campaignId: string, payerUserId: string, input: SponsorGrant) {
    return this.sponsorship.grant(campaignId, payerUserId, input);
  }
  revokeSponsor(campaignId: string, payerUserId: string, sponsorId: string) {
    return this.sponsorship.revoke(campaignId, payerUserId, sponsorId);
  }
  sponsors(campaignId: string, payerUserId: string) {
    return this.sponsorship.list(campaignId, payerUserId);
  }
  activeSponsor(campaignId: string, purpose: AiScope['purpose'] = 'plan') {
    return this.sponsorship.active(campaignId, purpose);
  }
  contextBudgetBytes() {
    return Math.min(
      this.policy.maxContextBytes,
      this.provider.contextBudgetBytes?.(this.policy.providerUpperMicros) ??
        this.policy.maxContextBytes,
    );
  }
  contextWindow() {
    return this.provider.contextWindow?.();
  }
  contextFits(purpose: AiScope['purpose'], context: unknown) {
    return this.provider.contextFits?.(purpose ?? 'plan', context) ?? true;
  }
  packContext<T extends object>(context: T, purpose: AiScope['purpose']) {
    if (!this.contextWindow()) return { ...context, budgetExceeded: false };
    return packNpcContextWindow(context, (value) => this.contextFits(purpose, value));
  }
  manualLive() {
    return this.provider.manualLive === true;
  }
  manualRequestAuthorized(id: string, context?: unknown) {
    return this.provider.requestAuthorized?.(id, context) ?? Promise.resolve(false);
  }
  async rejectManualUnqueuedRequest(c: PoolClient, requestId: string, code: string) {
    return this.provider instanceof ManualLiveProvider ||
      this.provider instanceof ReleaseGenerationProvider
      ? this.provider.session.rejectUndispatchedRequest(c, requestId, code)
      : false;
  }
  public configuration() {
    return {
      ...(this.contextWindow() ? { textContext: this.contextWindow() } : {}),
      provider: this.provider.external ? 'external' : 'mock',
      enabled: !this.policy.killSwitch && (!this.provider.external || this.policy.externalApproved),
      externalCallsEnabled:
        this.provider.external && this.policy.externalApproved && !this.policy.killSwitch,
      demo: !(this.provider instanceof ReleaseGenerationProvider),
      creditPrice: this.policy.creditPrice,
      providerUpperMicros: this.policy.providerUpperMicros,
      sponsorLimits: {
        maxOperations: 1000,
        maxExpiryHours: 24,
        purposes: [
          'plan',
          'summary',
          'speech',
          'intent',
          'supporting_npc',
          'narrative',
          'story_turn',
        ],
      },
      policyVersion: this.policy.version,
      timeoutMs: this.policy.timeoutMs,
    };
  }
  private async authorize(c: PoolClient, scope: AiScope) {
    const s = scopeSchema.parse(scope);
    const condition =
      s.origin === 'user'
        ? `AND EXISTS(SELECT 1 FROM game_members m JOIN users u ON u.id=m.user_id WHERE m.campaign_id=c.id AND m.user_id=$2 AND m.status='accepted' AND u.deleted_at IS NULL) AND ${sourceAccessSql('$2')}`
        : `AND ${sourceLiveSql()}`;
    if (s.origin === 'user' && !s.requesterUserId) fail(403, 'FORBIDDEN', 'FORBIDDEN');
    const r = await c.query(
      `SELECT c.id FROM game_campaigns c JOIN users owner ON owner.id=c.owner_id WHERE c.id=$1 AND c.status='active' AND owner.deleted_at IS NULL ${condition}`,
      s.origin === 'user' ? [s.campaignId, s.requesterUserId] : [s.campaignId],
    );
    if (!r.rowCount) fail(403, 'FORBIDDEN', 'FORBIDDEN');
    if (
      (s.purpose === 'intent' ||
        s.purpose === 'supporting_npc' ||
        s.purpose === 'narrative' ||
        s.purpose === 'story_turn') !==
      (s.subjectKind === 'player')
    )
      fail(403, 'INVALID_AI_SUBJECT', 'INVALID_AI_SUBJECT');
    if (
      s.purpose === 'supporting_npc' &&
      !(
        await c.query('SELECT 1 FROM game_campaigns WHERE id=$1 AND owner_id=$2', [
          s.campaignId,
          s.requesterUserId,
        ])
      ).rowCount
    )
      fail(403, 'FORBIDDEN', 'FORBIDDEN');
    if (
      s.subjectKind === 'player' &&
      (s.origin !== 'user' ||
        !(
          await c.query(
            "SELECT 1 FROM game_members WHERE campaign_id=$1 AND user_id=$2 AND actor_id=$3 AND status='accepted'",
            [s.campaignId, s.requesterUserId, s.npcId],
          )
        ).rowCount)
    )
      fail(403, 'FORBIDDEN', 'FORBIDDEN');
  }
  /** Only the exact built-in, zero-cost/zero-credit simulator may skip paid admission.
   * Arbitrary non-external adapters, subclasses and priced mock fixtures still need a quote.
   */
  private isFreeBuiltInSimulation() {
    return (
      this.provider instanceof MockNpcProvider &&
      Object.getPrototypeOf(this.provider) === MockNpcProvider.prototype &&
      this.provider.isFreeSimulation() &&
      this.provider.external === false &&
      this.policy.creditPrice === 0 &&
      this.policy.providerUpperMicros === 0
    );
  }
  private requestPlan(scope: AiScope, context: DecisionContext) {
    const snapshot =
      this.provider.prepareTextRequest?.(scope.purpose ?? 'plan', context)?.snapshot ?? null;
    const reserveMicros = snapshot?.reserveMicros ?? this.policy.providerUpperMicros;
    if (
      !Number.isSafeInteger(reserveMicros) ||
      reserveMicros < 0 ||
      reserveMicros > this.policy.providerUpperMicros
    )
      fail(409, 'PROVIDER_BUDGET_EXCEEDED', 'PROVIDER_BUDGET_EXCEEDED');
    return { snapshot, reserveMicros };
  }
  async quote(
    scope: AiScope,
    input: DecisionContext,
    requesterUserId: string,
    client?: PoolClient,
  ) {
    const context = validateDecisionContext(input, this.policy.maxContextBytes);
    if (!this.contextFits(scope.purpose, context))
      fail(413, 'TEXT_CONTEXT_WINDOW_EXCEEDED', 'TEXT_CONTEXT_WINDOW_EXCEEDED');
    const requestPlan = this.requestPlan(scope, context);
    const run = async (c: PoolClient) => {
      await this.authorize(c, { ...scope, origin: 'user', requesterUserId });
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `npc-ai-quote:${requesterUserId}`,
      ]);
      const recent = (
        await c.query(
          "SELECT count(*)::int AS count FROM npc_ai_quotes WHERE user_id=$1 AND created_at>now()-interval '1 minute'",
          [requesterUserId],
        )
      ).rows[0];
      if (recent.count >= 60) fail(429, 'RATE_LIMITED', 'RATE_LIMITED');
      const id = randomUUID(),
        expires = new Date(Date.now() + this.policy.quoteMs);
      if (this.provider instanceof ReleaseGenerationProvider) {
        this.provider.session.release!.current();
        await this.provider.session.release!.actor(c, requesterUserId);
        if (!(await sparksEnabled(c, requesterUserId)))
          fail(409, 'SPARK_WALLET_NOT_ENABLED', 'SPARK_WALLET_NOT_ENABLED');
      }
      const sparkMode =
        !(this.provider instanceof ManualLiveProvider) &&
        !this.isFreeBuiltInSimulation() &&
        (await sparksEnabled(c, requesterUserId));
      if (sparkMode && !requestPlan.snapshot)
        fail(409, 'SPARK_PRICE_UNVERIFIED', 'SPARK_PRICE_UNVERIFIED');
      const sparkQuote = sparkMode
        ? await new SparksAccounting().quote(c, {
            ownerId: requesterUserId,
            operationId: id,
            sourceKind: 'npc',
            sourceId: id,
            reserveSubunits: String(requestPlan.reserveMicros),
            expiresAt: expires.toISOString(),
            providerQuote: {
              ...requestPlan.snapshot!,
              policyVersion: this.policy.version,
              contextHash: context.contextHash,
            },
            tariff: sparkTariff(
              requestPlan.snapshot!,
              this.provider.id,
              requestPlan.snapshot!.providerFingerprint,
            ),
          })
        : null;
      await c.query(
        `INSERT INTO npc_ai_quotes(id,campaign_id,npc_id,user_id,context_hash,purpose,provider_id,policy_version,credits,upper_micros,expires_at,provider_version,request_snapshot,spark_quote_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          id,
          scope.campaignId,
          scope.npcId,
          requesterUserId,
          context.contextHash,
          scope.purpose ?? 'plan',
          this.provider.id,
          this.policy.version,
          sparkMode ? 0 : this.policy.creditPrice,
          requestPlan.reserveMicros,
          expires,
          this.provider.version,
          requestPlan.snapshot ? JSON.stringify(requestPlan.snapshot) : null,
          sparkQuote?.id ?? null,
        ],
      );
      return {
        id,
        credits: sparkMode ? 0 : this.policy.creditPrice,
        chargeUnit: sparkMode ? ('sparks' as const) : ('credits' as const),
        sparkReservedSubunits: sparkMode ? String(requestPlan.reserveMicros) : null,
        expiresAt: expires.toISOString(),
        demo: !sparkMode,
        requiresConsent: sparkMode || this.policy.creditPrice > 0 || this.provider.external,
        providerUpperMicros: requestPlan.snapshot ? null : requestPlan.reserveMicros,
        providerReserveMicros: requestPlan.reserveMicros,
        ...(requestPlan.snapshot
          ? {
              estimateSnapshot: requestPlan.snapshot,
              estimatedTotalMicros: requestPlan.snapshot.estimatedTotalMicros,
              providerEnforcesQuotedCap: false,
            }
          : {}),
        provider: this.provider.id,
        external: this.provider.external,
        policyVersion: this.policy.version,
      };
    };
    return client ? run(client) : this.db.tx(run);
  }
  private async turnAuthorized(c: PoolClient, campaignId: string, context: DecisionContext) {
    const row = (await c.query('SELECT state FROM game_campaigns WHERE id=$1', [campaignId]))
      .rows[0];
    // Contexts are server-built. Bind presentation to the explicit recipient, never
    // an arbitrary audience member. Check before cache lookup and again at dispatch.
    const actorId =
      typeof context.actorId === 'string'
        ? context.actorId
        : typeof context.recipientId === 'string'
          ? context.recipientId
          : undefined;
    if (actorId && row?.state?.entities?.[actorId]?.kind === 'player') {
      const current = row.state.narrativePreferences?.[actorId];
      if (digest(current ?? null) !== digest(context.narrativePreferences ?? null)) return false;
    } else if (context.narrativePreferences !== undefined) return false;
    const turn = row?.state?.turnController;
    if (!turn) return true;
    const fence = context.turnFence as
      { roundId?: unknown; phaseEpoch?: unknown; rulesetVersion?: unknown } | undefined;
    return (
      turn.phase === 'world' &&
      !!fence &&
      fence.roundId === turn.roundId &&
      fence.phaseEpoch === turn.phaseEpoch &&
      fence.rulesetVersion === turn.ruleset.version
    );
  }
  private dto(job: Job) {
    const sparkCharged =
      !!job.spark_hold_id ||
      (this.provider instanceof ReleaseGenerationProvider && !!job.generation_reservation_id);
    return {
      id: job.id,
      npcId: job.npc_id,
      subjectKind: job.subject_kind,
      purpose: job.purpose,
      status: job.status,
      credits: job.credits,
      chargeUnit: sparkCharged ? ('sparks' as const) : ('credits' as const),
      sparkReservedSubunits: sparkCharged ? String(job.provider_upper_micros) : null,
      sparkHoldId: job.spark_hold_id ?? null,
      reservationStatus: job.reservation_status,
      code: job.result_code ?? null,
      createdAt: job.created_at.toISOString(),
      demo: !(
        this.provider instanceof ReleaseGenerationProvider && job.provider_id === this.provider.id
      ),
    };
  }
  async replay(
    scope: AiScope,
    operationId: string,
    quoteId?: string,
    consent = false,
    requestKey = '',
    sponsorId?: string,
    runtimeRequestId?: string,
  ) {
    z.uuid().parse(operationId);
    return this.db.tx(async (c) => {
      await this.authorize(c, scope);
      const j = (
        await c.query<Job>('SELECT * FROM npc_ai_jobs WHERE campaign_id=$1 AND operation_id=$2', [
          scope.campaignId,
          operationId,
        ])
      ).rows[0];
      if (!j) return null;
      if (
        j.npc_id !== scope.npcId ||
        j.origin !== scope.origin ||
        j.subject_kind !== (scope.subjectKind ?? 'npc') ||
        j.requester_user_id !== (scope.requesterUserId ?? null) ||
        j.purpose !== (scope.purpose ?? 'plan') ||
        digest(publicRequestMeta(j.request_meta)) !==
          digest({
            quoteId: quoteId ?? null,
            consent,
            requestKey,
            sponsorId: sponsorId ?? null,
            runtimeRequestId: runtimeRequestId ?? null,
          })
      )
        fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
      return this.dto(j);
    });
  }
  async queue(input: QueueDecision) {
    const scope = scopeSchema.parse({
      ...input.scope,
      requesterUserId: input.requesterUserId ?? input.scope.requesterUserId,
    });
    z.uuid().parse(input.operationId);
    const context = validateDecisionContext(input.context, this.policy.maxContextBytes);
    const requestHash = digest({
      scope,
      context,
      quoteId: input.quoteId ?? null,
      consent: input.consent ?? false,
      requestKey: input.requestKey ?? '',
      sponsorId: input.sponsorId ?? null,
      runtimeRequestId: input.runtimeRequestId ?? null,
    });
    return this.db.tx(async (c) => {
      let generationAuthorizationId =
        this.provider instanceof ManualLiveProvider
          ? await this.provider.session.preparedAuthorizationId(c)
          : null;
      if (
        this.provider instanceof ManualLiveProvider &&
        this.provider.session.mode === 'owner' &&
        !generationAuthorizationId
      )
        fail(409, 'GENERATION_CONSENT_REQUIRED', 'GENERATION_CONSENT_REQUIRED');
      await c.query(
        'SELECT a.id FROM game_campaigns c JOIN game_playable_versions v ON v.id=c.source_version_id JOIN adventures a ON a.id=v.adventure_id WHERE c.id=$1 FOR SHARE OF a',
        [scope.campaignId],
      );
      await this.authorize(c, scope);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `npc-ai:${scope.campaignId}`,
      ]);
      // Serialize consent/access checks against member/source invitation revocations before the request claim.
      await c.query(
        'SELECT user_id FROM game_members WHERE campaign_id=$1 ORDER BY user_id FOR SHARE',
        [scope.campaignId],
      );
      await c.query(
        'SELECT i.id FROM adventure_invitations i JOIN game_playable_versions v ON v.adventure_id=i.adventure_id JOIN game_campaigns gc ON gc.source_version_id=v.id WHERE gc.id=$1 ORDER BY i.id FOR SHARE OF i',
        [scope.campaignId],
      );
      await this.authorize(c, scope);
      const previous = (
        await c.query<Job>('SELECT * FROM npc_ai_jobs WHERE campaign_id=$1 AND operation_id=$2', [
          scope.campaignId,
          input.operationId,
        ])
      ).rows[0];
      if (previous) {
        if (
          previous.request_hash !== requestHash &&
          !(
            previous.npc_id === scope.npcId &&
            previous.origin === scope.origin &&
            previous.subject_kind === (scope.subjectKind ?? 'npc') &&
            previous.requester_user_id === (scope.requesterUserId ?? null) &&
            previous.purpose === (scope.purpose ?? 'plan') &&
            digest(previous.context) === digest(context) &&
            digest(publicRequestMeta(previous.request_meta)) === digest(publicRequestMeta(input))
          )
        )
          fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
        return this.dto(previous);
      }
      const releaseProvider =
        this.provider instanceof ReleaseGenerationProvider ? this.provider : null;
      const hasReleasePermit =
        releaseProvider &&
        input.runtimeRequestId &&
        (
          await c.query('SELECT 1 FROM live_test_text_permits WHERE request_id=$1', [
            input.runtimeRequestId,
          ])
        ).rowCount;
      const releasePermit = hasReleasePermit
        ? await releaseProvider.session.preparedReleaseAuthorization(
            c,
            input.runtimeRequestId,
            scope.campaignId,
            context,
            scope.requesterUserId,
          )
        : null;
      if (releaseProvider && !scope.requesterUserId && !releasePermit)
        fail(403, 'GENERATION_EXPLICIT_PAYER_REQUIRED', 'GENERATION_EXPLICIT_PAYER_REQUIRED');
      if (releaseProvider && input.sponsorId)
        fail(403, 'SPARK_SPONSOR_POLICY_REQUIRED', 'SPARK_SPONSOR_POLICY_REQUIRED');
      if (releasePermit) generationAuthorizationId = releasePermit.authorizationId;
      if (!(await this.turnAuthorized(c, scope.campaignId, context)))
        fail(409, 'TURN_PHASE_STALE', 'TURN_PHASE_STALE');
      if (this.policy.killSwitch || (this.provider.external && !this.policy.externalApproved))
        fail(503, 'PROVIDER_DISABLED', 'PROVIDER_DISABLED');
      if (!this.contextFits(scope.purpose, context))
        fail(413, 'TEXT_CONTEXT_WINDOW_EXCEEDED', 'TEXT_CONTEXT_WINDOW_EXCEEDED');
      const requestPlan = this.requestPlan(scope, context);
      const count = Number(
        (
          await c.query(
            "SELECT count(*) FROM npc_ai_jobs WHERE campaign_id=$1 AND status IN ('queued','reserved','running','result_received','validated','reconciling')",
            [scope.campaignId],
          )
        ).rows[0].count,
      );
      if (count >= this.policy.maxQueuedPerCampaign) fail(429, 'RATE_LIMITED', 'RATE_LIMITED');
      let payer: string | null = null;
      const sparkMode =
        !!scope.requesterUserId &&
        (
          await c.query('SELECT enabled FROM spark_wallets WHERE owner_id=$1', [
            scope.requesterUserId,
          ])
        ).rows[0]?.enabled === true;
      // No Spark sponsorship policy exists yet, including mixed paid-requester/demo-payer flows.
      if (input.sponsorId && sparkMode)
        fail(403, 'SPARK_SPONSOR_POLICY_REQUIRED', 'SPARK_SPONSOR_POLICY_REQUIRED');
      if (releaseProvider && scope.requesterUserId && !sparkMode)
        fail(409, 'SPARK_WALLET_NOT_ENABLED', 'SPARK_WALLET_NOT_ENABLED');
      const ownSparkHold =
        sparkMode &&
        !(this.provider instanceof ManualLiveProvider) &&
        !releasePermit &&
        !this.isFreeBuiltInSimulation();
      let sparkQuoteId: string | null = null;
      if (
        (ownSparkHold ||
          (releasePermit && input.quoteId) ||
          this.policy.creditPrice > 0 ||
          (this.provider.external && scope.purpose === 'narrative') ||
          scope.purpose === 'story_turn') &&
        !input.sponsorId
      ) {
        if (!input.consent || !input.quoteId || !scope.requesterUserId)
          fail(403, 'CONSENT_REQUIRED', 'CONSENT_REQUIRED');
        const q = (
          await c.query('SELECT * FROM npc_ai_quotes WHERE id=$1 FOR UPDATE', [input.quoteId])
        ).rows[0];
        if (
          !q ||
          q.user_id !== scope.requesterUserId ||
          q.campaign_id !== scope.campaignId ||
          q.npc_id !== scope.npcId ||
          q.context_hash !== context.contextHash ||
          q.purpose !== (scope.purpose ?? 'plan') ||
          q.provider_id !== this.provider.id ||
          q.provider_version !== this.provider.version ||
          q.policy_version !== this.policy.version ||
          q.credits !== (ownSparkHold ? 0 : this.policy.creditPrice) ||
          (ownSparkHold && !q.spark_quote_id) ||
          Number(q.upper_micros) !== requestPlan.reserveMicros ||
          digest(q.request_snapshot ?? null) !== digest(requestPlan.snapshot) ||
          new Date(q.expires_at).getTime() <= Date.now()
        )
          fail(409, 'QUOTE_EXPIRED', 'QUOTE_EXPIRED');
        if (
          (await c.query('SELECT 1 FROM npc_ai_jobs WHERE quote_id=$1', [input.quoteId])).rowCount
        )
          fail(409, 'QUOTE_CONSUMED', 'QUOTE_CONSUMED');
        payer = scope.requesterUserId!;
        sparkQuoteId = ownSparkHold ? q.spark_quote_id : null;
      }
      if (releasePermit) payer = releasePermit.payerId;
      const live = await c.query(
        "SELECT id FROM npc_ai_jobs WHERE campaign_id=$1 AND npc_id=$2 AND status IN ('queued','reserved','running','result_received','validated','reconciling') FOR UPDATE",
        [scope.campaignId, scope.npcId],
      );
      if (live.rowCount) fail(409, 'NPC_AI_BUSY', 'NPC_AI_BUSY');
      if (input.runtimeRequestId) {
        const request = (
          await c.query('SELECT * FROM game_npc_decision_requests WHERE id=$1 FOR UPDATE', [
            input.runtimeRequestId,
          ])
        ).rows[0];
        if (
          !request ||
          request.status !== 'queued' ||
          request.campaign_id !== scope.campaignId ||
          request.npc_id !== scope.npcId ||
          request.purpose !== (scope.purpose ?? 'plan') ||
          request.context.contextHash !== context.contextHash
        )
          fail(409, 'RUNTIME_REQUEST_STALE', 'RUNTIME_REQUEST_STALE');
      }
      if (input.sponsorId) {
        if (!(
          (scope.origin === 'system' && !scope.requesterUserId && scope.subjectKind !== 'player') ||
          (scope.origin === 'user' &&
            scope.subjectKind === 'player' &&
            (scope.purpose === 'intent' ||
              scope.purpose === 'supporting_npc' ||
              scope.purpose === 'narrative' ||
              scope.purpose === 'story_turn'))
        ))
          fail(403, 'INVALID_SPONSOR_ORIGIN', 'INVALID_SPONSOR_ORIGIN');
        payer = await this.sponsorship.validate(
          c,
          input.sponsorId,
          scope.campaignId,
          scope.purpose ?? 'plan',
          true,
        );
      }
      if (
        input.sponsorId &&
        payer &&
        (await c.query('SELECT enabled FROM spark_wallets WHERE owner_id=$1', [payer])).rows[0]
          ?.enabled === true
      )
        fail(403, 'SPARK_SPONSOR_POLICY_REQUIRED', 'SPARK_SPONSOR_POLICY_REQUIRED');
      if (payer && !sparkMode && !releaseProvider) {
        const wallet = (
          await c.query('SELECT balance FROM wallets WHERE user_id=$1 FOR UPDATE', [payer])
        ).rows[0];
        const held = Number(
          (
            await c.query(
              "SELECT COALESCE(sum(credits),0) AS held FROM npc_ai_jobs WHERE payer_user_id=$1 AND reservation_status='held'",
              [payer],
            )
          ).rows[0].held,
        );
        if (!wallet || wallet.balance - held < this.policy.creditPrice)
          fail(409, 'BUDGET_EXCEEDED', 'BUDGET_EXCEEDED');
      }
      await c.query(
        'INSERT INTO npc_ai_provider_budgets(provider_id,cap_micros,unlimited_allowance) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [this.provider.id, this.policy.providerCapMicros, this.policy.providerCapMicros === null],
      );
      const budget = (
        await c.query('SELECT * FROM npc_ai_provider_budgets WHERE provider_id=$1 FOR UPDATE', [
          this.provider.id,
        ])
      ).rows[0];
      let releasePolicy: Awaited<
        ReturnType<NonNullable<GenerationAuthority['release']>['policy']>
      > | null = null;
      if (releaseProvider) {
        if (!payer)
          fail(403, 'GENERATION_EXPLICIT_PAYER_REQUIRED', 'GENERATION_EXPLICIT_PAYER_REQUIRED');
        releasePolicy = await releaseProvider.session.release!.policy(
          c,
          payer!,
          generationAuthorizationId ?? undefined,
        );
        generationAuthorizationId = releasePolicy.generationAuthorizationId!;
      }
      await this.excludeLegacyOwnerBypass(c);
      if (budget.blocked) fail(503, 'PROVIDER_DISABLED', 'PROVIDER_DISABLED');
      const liabilities =
        Number(budget.reserved_micros) +
        Number(budget.spent_micros) +
        Number(budget.unknown_micros);
      const unlimited =
        releaseProvider?.session.releaseConfig?.allowance === 'unlimited' &&
        this.policy.providerCapMicros === null;
      // release.policy above validates the persisted actor/scope unlimited flag under locks.
      if (
        !unlimited &&
        (budget.cap_micros === null ||
          budget.unlimited_allowance === true ||
          this.policy.providerCapMicros === null)
      )
        fail(409, 'GENERATION_POLICY_CHANGED', 'GENERATION_POLICY_CHANGED');
      let cap: number | null = unlimited
        ? null
        : Math.min(Number(budget.cap_micros), this.policy.providerCapMicros!);
      if (this.provider instanceof ManualLiveProvider && this.provider.session.mode === 'owner') {
        // The financial row precedes the common fence. Read the accepted policy without
        // locking another authorization/scope, then retain this fence through job insertion.
        await fenceGenerationAdmission(c);
        cap = await this.provider.session.acknowledgedTextCap(c, generationAuthorizationId!);
        if (cap === null || cap < liabilities)
          fail(
            409,
            'GENERATION_CAP_BELOW_HISTORICAL_SPEND',
            'GENERATION_CAP_BELOW_HISTORICAL_SPEND',
          );
      }
      if (cap !== null && liabilities + requestPlan.reserveMicros > cap)
        fail(409, 'PROVIDER_BUDGET_EXCEEDED', 'PROVIDER_BUDGET_EXCEEDED');
      if (
        this.provider instanceof ManualLiveProvider &&
        this.provider.session.mode === 'owner' &&
        Number(budget.cap_micros) !== cap
      )
        await c.query('UPDATE npc_ai_provider_budgets SET cap_micros=$2 WHERE provider_id=$1', [
          this.provider.id,
          cap,
        ]);
      if (unlimited && (budget.cap_micros !== null || budget.unlimited_allowance !== true))
        await c.query(
          'UPDATE npc_ai_provider_budgets SET cap_micros=NULL,unlimited_allowance=true WHERE provider_id=$1',
          [this.provider.id],
        );
      // Match finalizer lock order: job/provider budget, then Spark wallet.
      // Mode changes cannot turn an accepted demo quote into implicit paid consent (or vice versa).
      const walletModes = new Map<string, boolean>();
      const walletOwners = [scope.requesterUserId, input.sponsorId ? payer : null].filter(
        (owner): owner is string => !!owner,
      );
      for (const owner of [...new Set(walletOwners)].sort())
        walletModes.set(owner, await sparksEnabled(c, owner));
      if (scope.requesterUserId && walletModes.get(scope.requesterUserId) !== sparkMode)
        fail(409, 'SPARK_POLICY_CHANGED', 'SPARK_POLICY_CHANGED');
      if (input.sponsorId && payer && walletModes.get(payer))
        fail(403, 'SPARK_SPONSOR_POLICY_REQUIRED', 'SPARK_SPONSOR_POLICY_REQUIRED');
      const id = randomUUID();
      let generationReservationId: string | null = null;
      if (releaseProvider && releasePolicy) {
        if (releasePermit) {
          const permit = (
            await c.query(
              "SELECT reservation_id FROM live_test_text_permits WHERE request_id=$1 AND session_id=$2 AND state='authorized'",
              [input.runtimeRequestId, generationAuthorizationId],
            )
          ).rows[0];
          if (!permit) fail(409, 'GENERATION_PERMIT_CHANGED', 'GENERATION_PERMIT_CHANGED');
          generationReservationId = permit.reservation_id;
        } else {
          if (!sparkQuoteId || !payer) fail(409, 'SPARK_QUOTE_REQUIRED', 'SPARK_QUOTE_REQUIRED');
          generationReservationId = await reserveGenerationSpend(
            c,
            requestPlan.snapshot?.costBasis === 'operator_estimate'
              ? {
                  ...releasePolicy,
                  verifiedUpperMicros: null,
                  costBasis: 'approved_estimate',
                  estimatedTotalMicros: requestPlan.snapshot.estimatedTotalMicros,
                  operationalReserveMicros: requestPlan.reserveMicros,
                }
              : releasePolicy,
            payer!,
            'text',
            `release-npc:${id}`,
            requestPlan.reserveMicros,
          );
        }
      }
      const sparkHold =
        sparkQuoteId && payer ? await new SparksAccounting().reserve(c, payer, sparkQuoteId) : null;
      const r = await c.query<Job>(
        `INSERT INTO npc_ai_jobs(id,campaign_id,npc_id,operation_id,request_hash,origin,requester_user_id,payer_user_id,purpose,context_hash,context,provider_id,provider_version,policy_version,status,credits,reservation_status,reservation_expires_at,provider_upper_micros,provider_budget_status,quote_id,request_meta,sponsor_id,subject_kind,provider_external,generation_authorization_id,request_snapshot,spark_hold_id,generation_reservation_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'reserved',$15,$16,$17,$18,'reserved',$19,$20,$21,$22,$23,$24,$25,$26,$27) RETURNING *`,
        [
          id,
          scope.campaignId,
          scope.npcId,
          input.operationId,
          requestHash,
          scope.origin,
          scope.requesterUserId ?? null,
          payer,
          scope.purpose ?? 'plan',
          context.contextHash,
          JSON.stringify(context),
          this.provider.id,
          this.provider.version,
          this.policy.version,
          sparkMode ? 0 : this.policy.creditPrice,
          payer ? 'held' : 'none',
          new Date(Date.now() + this.policy.reservationMs),
          requestPlan.reserveMicros,
          payer && !input.sponsorId ? input.quoteId : null,
          JSON.stringify({
            quoteId: input.quoteId ?? null,
            consent: input.consent ?? false,
            requestKey: input.requestKey ?? '',
            sponsorId: input.sponsorId ?? null,
            runtimeRequestId: input.runtimeRequestId ?? null,
          }),
          input.sponsorId ?? null,
          scope.subjectKind ?? 'npc',
          this.provider.external === true,
          generationAuthorizationId,
          requestPlan.snapshot ? JSON.stringify(requestPlan.snapshot) : null,
          sparkHold?.id ?? null,
          generationReservationId,
        ],
      );
      if (generationReservationId && sparkHold) {
        const linked = await c.query(
          'UPDATE generation_budget_reservations SET spark_quote_id=$2 WHERE id=$1 AND actor_id=$3 AND spark_quote_id IS NULL',
          [generationReservationId, sparkHold.id, payer],
        );
        if (linked.rowCount !== 1)
          fail(409, 'SPARK_RESERVATION_CONFLICT', 'SPARK_RESERVATION_CONFLICT');
      }
      if (input.runtimeRequestId)
        await c.query(
          "UPDATE game_npc_decision_requests SET status='scheduled',job_id=$2 WHERE id=$1",
          [input.runtimeRequestId, id],
        );
      await c.query(
        'UPDATE npc_ai_provider_budgets SET reserved_micros=reserved_micros+$2 WHERE provider_id=$1',
        [this.provider.id, requestPlan.reserveMicros],
      );
      return this.dto(r.rows[0]);
    });
  }
  async pending(campaignId: string) {
    return Boolean(
      (
        await this.db.query(
          "SELECT 1 FROM npc_ai_jobs WHERE campaign_id=$1 AND status IN ('reserved','running','result_received','validated') LIMIT 1",
          [campaignId],
        )
      ).length,
    );
  }
  async status(campaignId: string, viewerUserId: string) {
    return (
      await this.db.query<Job>(
        'SELECT * FROM npc_ai_jobs WHERE campaign_id=$1 AND (requester_user_id=$2 OR payer_user_id=$2) ORDER BY created_at DESC LIMIT 30',
        [campaignId, viewerUserId],
      )
    ).map((j) => this.dto(j));
  }
  async wallet(userId: string) {
    const r = (
      await this.db.query(
        "SELECT w.balance,COALESCE((SELECT sum(j.credits) FROM npc_ai_jobs j WHERE j.payer_user_id=w.user_id AND j.reservation_status='held'),0) AS reserved FROM wallets w WHERE user_id=$1",
        [userId],
      )
    )[0];
    return {
      balance: r?.balance ?? 0,
      reserved: Number(r?.reserved ?? 0),
      available: (r?.balance ?? 0) - Number(r?.reserved ?? 0),
      demo: !(this.provider instanceof ReleaseGenerationProvider),
    };
  }
  async runNext(campaignId: string, isActive: () => Promise<boolean>) {
    if (this.inFlight.has(campaignId)) return;
    this.inFlight.add(campaignId);
    try {
      await this.sweep(campaignId);
      const rows = await this.db.query<Job>(
        "SELECT * FROM npc_ai_jobs WHERE campaign_id=$1 AND status='reserved' AND ($2::text IS NULL OR provider_id=$2) AND NOT cancel_requested ORDER BY created_at LIMIT 1",
        [campaignId, this.provider instanceof ReleaseGenerationProvider ? this.provider.id : null],
      );
      if (rows[0]) await this.run(rows[0].id, isActive);
    } finally {
      this.inFlight.delete(campaignId);
    }
  }
  async run(id: string, isActive: () => Promise<boolean>) {
    if (this.provider instanceof ReleaseGenerationProvider) {
      const identity = (
        await this.db.query('SELECT provider_id FROM npc_ai_jobs WHERE id=$1', [id])
      )[0];
      if (!identity || identity.provider_id !== this.provider.id) return;
    }
    if (this.policy.killSwitch || !(await isActive())) return;
    if (this.provider.canDispatchJob && !(await this.provider.canDispatchJob(id))) return;
    const claimed = await this.db.tx(async (c) => {
      const scopeRow = (await c.query('SELECT campaign_id FROM npc_ai_jobs WHERE id=$1', [id]))
        .rows[0];
      if (!scopeRow) return null;
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `npc-ai:${scopeRow.campaign_id}`,
      ]);
      const j = (await c.query<Job>('SELECT * FROM npc_ai_jobs WHERE id=$1 FOR UPDATE', [id]))
        .rows[0];
      if (!j || j.status !== 'reserved' || j.cancel_requested) return null;
      if (this.provider.external && !(this.provider instanceof ManualLiveProvider)) {
        const budget = (
          await c.query(
            'SELECT provider_id FROM npc_ai_provider_budgets WHERE provider_id=$1 FOR UPDATE',
            [j.provider_id],
          )
        ).rows[0];
        if (!budget) fail(409, 'PROVIDER_BUDGET_MISSING', 'PROVIDER_BUDGET_MISSING');
        await this.excludeLegacyOwnerBypass(c);
        if (this.provider instanceof ReleaseGenerationProvider)
          await this.provider.session.release!.active(
            c,
            j.generation_authorization_id ?? undefined,
          );
      }
      if (
        j.provider_id !== this.provider.id ||
        j.provider_version !== this.provider.version ||
        j.policy_version !== this.policy.version
      ) {
        await this.finalize(c, id, 'stale');
        return null;
      }
      if (j.reservation_expires_at.getTime() <= Date.now()) {
        await this.finalize(c, id, 'stale');
        return null;
      }
      try {
        if (j.sponsor_id)
          await this.sponsorship.validate(c, j.sponsor_id, j.campaign_id, j.purpose, false);
        await this.authorize(c, {
          campaignId: j.campaign_id,
          npcId: j.npc_id,
          origin: j.origin,
          subjectKind: j.subject_kind,
          purpose: j.purpose,
          requesterUserId: j.requester_user_id ?? undefined,
        });
      } catch {
        await this.finalize(c, id, 'cancelled');
        return null;
      }
      if (!(await this.turnAuthorized(c, j.campaign_id, j.context))) {
        await this.finalize(c, id, 'stale');
        return null;
      }
      const key = cacheKey(
        { campaignId: j.campaign_id, npcId: j.npc_id, purpose: j.purpose },
        j.context,
        j.provider_id,
        j.provider_version,
        j.policy_version,
      );
      const cached = (
        await c.query('SELECT proposal FROM npc_ai_cache WHERE cache_key=$1 AND expires_at>now()', [
          key,
        ])
      ).rows[0];
      if (cached) {
        await this.settleNpcSparks(c, j, {
          outcome: 'application_cache',
          receiptId: `cache:${j.id}`,
        });
        await this.settleProvider(c, j, 0, false);
        await c.query(
          "UPDATE npc_ai_jobs SET status='result_received',proposal=$2,result_at=now(),reservation_status=CASE WHEN reservation_status='held' THEN 'released' ELSE reservation_status END,credits=0,result_code='CACHE_REUSED' WHERE id=$1",
          [id, JSON.stringify(cached.proposal)],
        );
        return null;
      }
      const busy = (
        await c.query(
          "SELECT 1 FROM npc_ai_jobs WHERE campaign_id=$1 AND status='running' AND id<>$2 LIMIT 1",
          [j.campaign_id, id],
        )
      ).rowCount;
      if (busy) return null;
      await c.query(
        "UPDATE npc_ai_jobs SET status='running',started_at=now(),deadline_at=$2 WHERE id=$1",
        [id, new Date(Date.now() + this.policy.timeoutMs)],
      );
      return j;
    });
    if (!claimed) return;
    if (!(await isActive())) {
      await this.db.query(
        "UPDATE npc_ai_jobs SET status='reserved',started_at=NULL,deadline_at=NULL WHERE id=$1 AND status='running' AND NOT cancel_requested",
        [id],
      );
      return;
    }
    if (!(await this.db.tx((c) => this.turnAuthorized(c, claimed.campaign_id, claimed.context)))) {
      await this.db.tx((c) => this.finalize(c, id, 'stale'));
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.policy.timeoutMs);
    try {
      if (this.provider.external && !this.policy.externalApproved)
        throw new ProviderFailure('PROVIDER_DISABLED', false);
      const result = validateProviderResult(
        await Promise.race([
          this.provider.generate({
            jobId: id,
            purpose: claimed.purpose,
            context: claimed.context,
            signal: controller.signal,
            maxCostMicros: Number(claimed.provider_upper_micros),
            ...(claimed.request_snapshot
              ? { textReservationSnapshot: claimed.request_snapshot }
              : {}),
          }),
          new Promise<never>((_, reject) =>
            controller.signal.addEventListener(
              'abort',
              () => reject(new ProviderFailure('PROVIDER_TIMEOUT', true)),
              { once: true },
            ),
          ),
        ]),
      );
      if (Buffer.byteLength(JSON.stringify(result.proposal)) > this.policy.maxResultBytes)
        throw new ProviderFailure('PROVIDER_RESULT_TOO_LARGE', true);
      await this.db.tx(async (c) => {
        const j = (await c.query<Job>('SELECT * FROM npc_ai_jobs WHERE id=$1 FOR UPDATE', [id]))
          .rows[0];
        if (
          !j ||
          (!['running', 'reconciling'].includes(j.status) && j.provider_budget_status !== 'unknown')
        )
          return;
        await c.query(
          'UPDATE npc_ai_jobs SET provider_cost_evidence=$2,provider_usage=COALESCE(provider_usage,$3::jsonb) WHERE id=$1',
          [id, result.usage.costEvidence ?? 'reported', JSON.stringify(result.usage)],
        );
        const hasCacheUsage =
          (result.usage.cachedInputTokens ?? 0) + (result.usage.cacheWriteInputTokens ?? 0) > 0;
        let pricedCache = false;
        if (
          hasCacheUsage &&
          result.usage.costVerifiedForSparks === true &&
          j.request_snapshot?.cachePricing
        ) {
          try {
            pricedCache =
              textUsageCostMicros(j.request_snapshot, result.usage).costMicros ===
              result.usage.costMicros;
          } catch {
            /* Missing or invalid immutable tariff stays pending. */
          }
        }
        if (result.usage.costVerifiedForSparks === false || (hasCacheUsage && !pricedCache))
          await this.settleNpcSparks(c, j, {
            outcome: 'failure_policy_pending',
            receiptId: `unpriced:${result.requestId}`,
          });
        if (result.usage.costMicros > Number(j.provider_upper_micros)) {
          await this.settleProvider(
            c,
            j,
            this.provider instanceof ReleaseGenerationProvider ? result.usage.costMicros : null,
            !(this.provider instanceof ReleaseGenerationProvider),
          );
          await c.query(
            'UPDATE npc_ai_provider_budgets SET blocked=blocked OR $3,overrun_micros=overrun_micros+$2 WHERE provider_id=$1',
            [
              j.provider_id,
              result.usage.costMicros - Number(j.provider_upper_micros),
              !(this.provider instanceof ReleaseGenerationProvider),
            ],
          );
          await c.query(
            'UPDATE npc_ai_jobs SET provider_actual_micros=$2,provider_request_id=$3 WHERE id=$1',
            [id, result.usage.costMicros, result.requestId],
          );
          await c.query(
            "UPDATE npc_ai_jobs SET status='reconciling',result_code='COST_BOUND_EXCEEDED',reservation_status=CASE WHEN reservation_status='held' THEN 'released' ELSE reservation_status END WHERE id=$1",
            [id],
          );
          return;
        }
        await this.settleProvider(c, j, result.usage.costMicros, false);
        await c.query(
          'UPDATE npc_ai_jobs SET provider_request_id=$2,input_tokens=$3,output_tokens=$4,provider_actual_micros=$5,cached_input_tokens=$6 WHERE id=$1',
          [
            id,
            result.requestId,
            result.usage.inputTokens,
            result.usage.outputTokens,
            result.usage.costMicros,
            result.usage.cachedInputTokens ?? null,
          ],
        );
        if (['cancelled', 'stale', 'failed', 'committed'].includes(j.status)) return;
        if (result.failureCode) {
          if (
            result.failureCode === 'PROVIDER_LIMIT_VIOLATION' &&
            !(this.provider instanceof ReleaseGenerationProvider)
          )
            await c.query('UPDATE npc_ai_provider_budgets SET blocked=true WHERE provider_id=$1', [
              j.provider_id,
            ]);
          await this.finalize(c, id, 'stale');
          await c.query('UPDATE npc_ai_jobs SET result_code=$2 WHERE id=$1', [
            id,
            result.failureCode,
          ]);
          return;
        }
        if (
          j.cancel_requested ||
          j.reservation_expires_at.getTime() <= Date.now() ||
          (j.reservation_status === 'released' && j.credits > 0)
        ) {
          await this.finalize(c, id, 'stale');
          return;
        }
        await c.query(
          "UPDATE npc_ai_jobs SET status='result_received',proposal=$2,result_at=now() WHERE id=$1",
          [id, JSON.stringify(result.proposal)],
        );
      });
    } catch (error) {
      const uncertain = !(error instanceof ProviderFailure) || error.uncertain;
      await this.db.tx(async (c) => {
        const j = (await c.query<Job>('SELECT * FROM npc_ai_jobs WHERE id=$1 FOR UPDATE', [id]))
          .rows[0];
        if (!j || !['running', 'reconciling'].includes(j.status)) return;
        if (error instanceof ProviderFailure && error.requestId)
          await c.query('UPDATE npc_ai_jobs SET provider_request_id=$2 WHERE id=$1', [
            id,
            error.requestId,
          ]);
        await this.settleNpcSparks(c, j, {
          outcome: 'failure_policy_pending',
          receiptId: `failure:${j.id}`,
        });
        await this.settleProvider(c, j, uncertain ? null : 0, uncertain);
        await c.query(
          "UPDATE npc_ai_jobs SET status=$2,result_code=$3,reservation_status=CASE WHEN reservation_status='held' THEN 'released' ELSE reservation_status END,completed_at=now() WHERE id=$1",
          [
            id,
            uncertain ? 'reconciling' : 'failed',
            error instanceof ProviderFailure ? error.code : 'PROVIDER_FAILURE',
          ],
        );
      });
    } finally {
      clearTimeout(timeout);
    }
  }
  private async settleNpcSparks(c: PoolClient, j: Job, settlement: SparkSettlement) {
    if (!j.spark_hold_id || !j.payer_user_id) return;
    // Wrapped jobs use their shared permit hold, never a second direct NPC hold.
    // Fail closed on inconsistent provenance before acquiring a wallet or foreign auth lock.
    if (this.provider instanceof ManualLiveProvider)
      fail(409, 'SPARK_ACCOUNTING_AUTHORITY_CONFLICT', 'SPARK_ACCOUNTING_AUTHORITY_CONFLICT');
    // Enqueue takes provider budget before wallet. All direct terminal callbacks,
    // including cache/failure/stale paths, must preserve that order before settleProvider.
    await c.query('SELECT * FROM npc_ai_provider_budgets WHERE provider_id=$1 FOR UPDATE', [
      j.provider_id,
    ]);
    if (this.provider instanceof ReleaseGenerationProvider) {
      if (!j.generation_reservation_id || !j.generation_authorization_id)
        fail(409, 'SPARK_ACCOUNTING_AUTHORITY_CONFLICT', 'SPARK_ACCOUNTING_AUTHORITY_CONFLICT');
      await this.provider.session.lockAuthorization(c, j.generation_authorization_id!);
      await settleReservationSparks(c, j.generation_reservation_id!, settlement);
      return;
    }
    const hold = (await c.query('SELECT status FROM spark_holds WHERE id=$1', [j.spark_hold_id]))
      .rows[0];
    // Terminal replay is a no-op; unknown/failure outcomes require explicit reconciliation.
    if (!hold || ['settled', 'released', 'pending'].includes(hold.status)) return;
    await new SparksAccounting().settle(c, j.payer_user_id, j.spark_hold_id, settlement);
  }
  private async settleProvider(c: PoolClient, j: Job, actual: number | null, unknown: boolean) {
    // Wrapped settlement can acquire authorization/scope -> global fence. Enqueue
    // already holds the provider budget before that fence, so acquire it first here too.
    await c.query('SELECT * FROM npc_ai_provider_budgets WHERE provider_id=$1 FOR UPDATE', [
      j.provider_id,
    ]);
    if (
      !(this.provider instanceof ManualLiveProvider) &&
      !(this.provider instanceof ReleaseGenerationProvider)
    )
      await fenceGenerationAdmission(c);
    if (this.provider instanceof ManualLiveProvider)
      await this.provider.session.settleJob(c, j.id, actual, unknown);
    if (this.provider instanceof ReleaseGenerationProvider) {
      if (!j.generation_authorization_id || !j.generation_reservation_id)
        fail(409, 'GENERATION_RESERVATION_REQUIRED', 'GENERATION_RESERVATION_REQUIRED');
      await this.provider.session.lockAuthorization(c, j.generation_authorization_id!);
      if (j.spark_hold_id) {
        if (actual !== null) await settleGenerationSpend(c, j.generation_reservation_id!, actual);
        if (
          unknown ||
          actual === null ||
          (actual !== null && actual > Number(j.provider_upper_micros))
        ) {
          await c.query(
            "UPDATE live_test_sessions SET state='stopped',stop_code=COALESCE(stop_code,'GENERATION_ACCOUNT_REVIEW_REQUIRED') WHERE id=$1",
            [j.generation_authorization_id],
          );
          await c.query(
            'UPDATE generation_budget_scopes SET blocked=true WHERE id=(SELECT scope_id FROM live_test_sessions WHERE id=$1)',
            [j.generation_authorization_id],
          );
        }
      } else await this.provider.session.settleJob(c, j.id, actual, unknown);
    }
    if (unknown)
      await this.settleNpcSparks(c, j, { outcome: 'unknown', receiptId: `unknown:${j.id}` });
    const upper = Number(j.provider_upper_micros);
    // This legacy row retains its admitted ceiling; full release liability is in the shared ledger, with excess separately tracked below.
    const accountedActual =
      this.provider instanceof ReleaseGenerationProvider
        ? Math.min(actual ?? 0, upper)
        : (actual ?? 0);
    if (j.provider_budget_status === 'reserved') {
      await c.query(
        'UPDATE npc_ai_provider_budgets SET reserved_micros=reserved_micros-$2,spent_micros=spent_micros+$3,unknown_micros=unknown_micros+$4 WHERE provider_id=$1',
        [j.provider_id, upper, unknown ? 0 : accountedActual, unknown ? upper : 0],
      );
    } else if (j.provider_budget_status === 'unknown' && !unknown) {
      await c.query(
        'UPDATE npc_ai_provider_budgets SET unknown_micros=unknown_micros-$2,spent_micros=spent_micros+$3 WHERE provider_id=$1',
        [j.provider_id, upper, accountedActual],
      );
    } else return;
    await c.query(
      'UPDATE npc_ai_jobs SET provider_budget_status=$2,provider_actual_micros=$3 WHERE id=$1',
      [j.id, unknown ? 'unknown' : actual ? 'spent' : 'released', actual],
    );
    j.provider_budget_status = unknown ? 'unknown' : actual ? 'spent' : 'released';
  }
  async ready(campaignId: string): Promise<ReadyDecision[]> {
    return (
      await this.db.query<Job>(
        "SELECT * FROM npc_ai_jobs WHERE campaign_id=$1 AND status='result_received' AND ($2::text IS NULL OR provider_id=$2) AND NOT cancel_requested ORDER BY created_at LIMIT 8",
        [campaignId, this.provider instanceof ReleaseGenerationProvider ? this.provider.id : null],
      )
    ).map((j) => ({
      id: j.id,
      campaignId: j.campaign_id,
      npcId: j.npc_id,
      origin: j.origin,
      subjectKind: j.subject_kind,
      requesterUserId: j.requester_user_id,
      purpose: j.purpose,
      contextHash: j.context_hash,
      context: j.context,
      proposal: j.proposal,
      createdAt: j.created_at.toISOString(),
    }));
  }
  async finalize(c: PoolClient, id: string, status: 'committed' | 'stale' | 'cancelled') {
    if (status === 'committed') {
      const lookup = (await c.query('SELECT campaign_id FROM npc_ai_jobs WHERE id=$1', [id]))
        .rows[0];
      if (lookup) {
        await c.query(
          'SELECT a.id FROM game_campaigns gc JOIN game_playable_versions v ON v.id=gc.source_version_id JOIN adventures a ON a.id=v.adventure_id WHERE gc.id=$1 FOR SHARE OF a',
          [lookup.campaign_id],
        );
        await c.query(
          'SELECT user_id FROM game_members WHERE campaign_id=$1 ORDER BY user_id FOR SHARE',
          [lookup.campaign_id],
        );
        await c.query(
          'SELECT i.id FROM adventure_invitations i JOIN game_playable_versions v ON v.adventure_id=i.adventure_id JOIN game_campaigns gc ON gc.source_version_id=v.id WHERE gc.id=$1 ORDER BY i.id FOR SHARE OF i',
          [lookup.campaign_id],
        );
      }
    }
    const j = (await c.query<Job>('SELECT * FROM npc_ai_jobs WHERE id=$1 FOR UPDATE', [id]))
      .rows[0];
    if (!j) return;
    if (j.status === 'committed') {
      if (status === 'committed') return;
      fail(409, 'ALREADY_COMMITTED', 'ALREADY_COMMITTED');
    }
    if (['stale', 'cancelled', 'failed'].includes(j.status)) {
      if (status === 'committed') fail(409, 'STALE_AI_RESULT', 'STALE_AI_RESULT');
      return;
    }
    if (status === 'committed') {
      if (
        this.policy.killSwitch ||
        j.provider_id !== this.provider.id ||
        j.provider_version !== this.provider.version ||
        j.policy_version !== this.policy.version ||
        j.status !== 'result_received' ||
        j.cancel_requested ||
        j.reservation_expires_at.getTime() <= Date.now() ||
        (j.reservation_status === 'released' && j.credits > 0)
      )
        fail(409, 'STALE_AI_RESULT', 'STALE_AI_RESULT');
      if (j.sponsor_id)
        await this.sponsorship.validate(c, j.sponsor_id, j.campaign_id, j.purpose, false);
      await this.authorize(c, {
        campaignId: j.campaign_id,
        npcId: j.npc_id,
        origin: j.origin,
        subjectKind: j.subject_kind,
        purpose: j.purpose,
        requesterUserId: j.requester_user_id ?? undefined,
      });
      if (j.spark_hold_id)
        await this.settleNpcSparks(
          c,
          j,
          j.provider_actual_micros === null
            ? { outcome: 'unknown', receiptId: `missing:${j.id}` }
            : {
                outcome: 'success',
                actualMicros: String(j.provider_actual_micros),
                evidence:
                  j.provider_cost_evidence === 'configured_rates' ? 'configured_rates' : 'reported',
                receiptId: `commit:${j.id}`,
              },
        );
      if (j.credits > 0) {
        if (j.reservation_status !== 'held' || !j.payer_user_id)
          fail(409, 'RESERVATION_REQUIRED', 'RESERVATION_REQUIRED');
        const wallet = (
          await c.query('SELECT balance FROM wallets WHERE user_id=$1 FOR UPDATE', [
            j.payer_user_id,
          ])
        ).rows[0];
        if (!wallet || wallet.balance < j.credits) fail(409, 'BUDGET_EXCEEDED', 'BUDGET_EXCEEDED');
        await c.query('UPDATE wallets SET balance=balance-$2 WHERE user_id=$1', [
          j.payer_user_id,
          j.credits,
        ]);
        await c.query(
          'INSERT INTO ledger(user_id,amount,reason,source_key,actor_id) VALUES($1,$2,$3,$4,$1)',
          [j.payer_user_id, -j.credits, 'npc_ai.demo_decision', `npc-ai:${j.id}:capture`],
        );
      }
      const key = cacheKey(
        { campaignId: j.campaign_id, npcId: j.npc_id, purpose: j.purpose },
        j.context,
        j.provider_id,
        j.provider_version,
        j.policy_version,
      );
      await c.query(
        `INSERT INTO npc_ai_cache(cache_key,campaign_id,npc_id,context_hash,purpose,provider_id,provider_version,policy_version,proposal,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(cache_key) DO UPDATE SET expires_at=EXCLUDED.expires_at`,
        [
          key,
          j.campaign_id,
          j.npc_id,
          j.context_hash,
          j.purpose,
          j.provider_id,
          j.provider_version,
          j.policy_version,
          JSON.stringify(j.proposal),
          new Date(Date.now() + this.policy.cacheMs),
        ],
      );
    } else {
      await this.settleNpcSparks(c, j, {
        outcome: j.status === 'reserved' ? 'not_dispatched' : 'failure_policy_pending',
        receiptId: `finalize:${j.id}:${status}`,
      });
      if (j.provider_budget_status === 'reserved')
        await this.settleProvider(c, j, j.status === 'running' ? null : 0, j.status === 'running');
    }
    if (
      this.provider instanceof ManualLiveProvider ||
      (this.provider instanceof ReleaseGenerationProvider && !j.spark_hold_id)
    )
      await this.provider.session.finalizeNpcSparks(
        c,
        j.id,
        status === 'committed',
        j.provider_actual_micros === null ? null : Number(j.provider_actual_micros),
      );
    await c.query(
      "UPDATE npc_ai_jobs SET status=$2,reservation_status=CASE WHEN reservation_status='held' THEN $3 ELSE reservation_status END,completed_at=now() WHERE id=$1",
      [id, status, status === 'committed' ? 'captured' : 'released'],
    );
  }
  /** Operator-only aggregate diagnostics: never include prompts, keys, player identities or proposals. */
  async metrics() {
    return this.db.tx(async (c) => {
      await c.query("SET LOCAL statement_timeout='2000ms'");
      const counts = (
        await c.query(`SELECT status,count(*)::int AS count,
        COALESCE(max(EXTRACT(EPOCH FROM (now()-created_at))),0)::int AS oldest_seconds
        FROM npc_ai_jobs GROUP BY status`)
      ).rows;
      const budgets = (
        await c.query(
          'SELECT provider_id,blocked,cap_micros,reserved_micros,spent_micros,unknown_micros,overrun_micros FROM npc_ai_provider_budgets',
        )
      ).rows;
      const latency = (
        await c.query(`SELECT count(*)::int AS samples,
        COALESCE(avg(EXTRACT(EPOCH FROM (result_at-started_at))*1000),0)::float8 AS average_ms,
        COALESCE(max(EXTRACT(EPOCH FROM (result_at-started_at))*1000),0)::float8 AS maximum_ms
        FROM (SELECT started_at,result_at FROM npc_ai_jobs WHERE result_at IS NOT NULL AND started_at IS NOT NULL
              ORDER BY created_at DESC LIMIT 10000) recent`)
      ).rows[0];
      const memory = (
        await c.query(`WITH campaigns AS (
        SELECT state FROM game_campaigns ORDER BY id LIMIT 1000
      ), living AS (
        SELECT brain.value->'living' AS memory FROM campaigns,
          LATERAL jsonb_each(COALESCE(state->'npcBrains','{}'::jsonb)) brain
        WHERE brain.value->'living' IS NOT NULL
      ) SELECT (SELECT count(*)::int FROM campaigns) AS sampled_campaigns,
        count(*)::int AS living_npcs,
        COALESCE(sum(jsonb_array_length(COALESCE(memory->'observations','[]'::jsonb))),0)::int AS hot_observations,
        COALESCE(sum(jsonb_array_length(COALESCE(memory->'causes','[]'::jsonb))),0)::int AS queued_causes,
        COALESCE(sum((SELECT count(*) FROM jsonb_array_elements(COALESCE(memory->'obligations','[]'::jsonb)) obligation
          WHERE obligation->>'status'='accepted')),0)::int AS accepted_obligations
      FROM living`)
      ).rows[0];
      const archive = (
        await c.query('SELECT count(*)::int AS archived_episodes FROM game_npc_episodes')
      ).rows[0];
      return {
        counts,
        budgets,
        latency,
        memory: { ...memory, ...archive, campaign_sample_limit: 1000 },
        statementTimeoutMs: 2000,
        npcTelemetry: npcTelemetrySnapshot(),
      };
    });
  }
  /** Fixed bounded terminal-context retention; financial evidence and unknown exposure are never deleted here. */
  async pruneContexts() {
    return this.db.tx(async (c) => {
      await c.query("SET LOCAL statement_timeout='2000ms'");
      const result = await c.query(`WITH expired AS (
        SELECT id FROM npc_ai_jobs WHERE status IN ('committed','stale','cancelled','failed','reconciling')
        AND COALESCE(completed_at,created_at)<now()-interval '7 days' AND (context<>'{}'::jsonb OR proposal IS NOT NULL)
        ORDER BY COALESCE(completed_at,created_at),id FOR UPDATE SKIP LOCKED LIMIT 1000
      ) UPDATE npc_ai_jobs j SET context='{}',proposal=NULL,context_hash='retention-expired' FROM expired e WHERE j.id=e.id`);
      await c.query(
        'DELETE FROM npc_ai_cache WHERE cache_key IN (SELECT cache_key FROM npc_ai_cache WHERE expires_at<=now() LIMIT 1000)',
      );
      return { removedContexts: result.rowCount ?? 0, retentionDays: 7 };
    });
  }
  async cancel(id: string) {
    await this.db.tx((c) => this.finalize(c, id, 'cancelled'));
  }
  async sweep(campaignId: string) {
    await this.db.tx(async (c) => {
      await c.query(
        "UPDATE npc_ai_jobs j SET cancel_requested=true,result_code='SPONSOR_UNAVAILABLE' FROM npc_ai_sponsors s WHERE j.sponsor_id=s.id AND j.campaign_id=$1 AND ($2::text IS NULL OR j.provider_id=$2) AND (s.revoked_at IS NOT NULL OR s.expires_at<=now()) AND j.status NOT IN ('committed','stale','cancelled','failed')",
        [campaignId, this.provider instanceof ReleaseGenerationProvider ? this.provider.id : null],
      );
      const jobs = (
        await c.query<Job>(
          "SELECT * FROM npc_ai_jobs WHERE campaign_id=$1 AND ($2::text IS NULL OR provider_id=$2) AND status IN ('reserved','running','result_received','validated') AND (cancel_requested OR reservation_expires_at<=now() OR (status='running' AND deadline_at<=now())) FOR UPDATE",
          [
            campaignId,
            this.provider instanceof ReleaseGenerationProvider ? this.provider.id : null,
          ],
        )
      ).rows;
      // A sweep can include historical providers. Lock the whole sorted financial
      // set before any callback acquires a shared authorization/global fence.
      await c.query(
        'SELECT * FROM npc_ai_provider_budgets WHERE provider_id=ANY($1::text[]) ORDER BY provider_id FOR UPDATE',
        [[...new Set(jobs.map((j) => j.provider_id))].sort()],
      );
      // Prelock every relevant authority/scope before the first global fence. A mixed
      // payer batch must never acquire a second actor scope while holding that fence.
      const authorizationIds = [
        ...new Set(
          jobs.map((j) => j.generation_authorization_id).filter((id): id is string => !!id),
        ),
      ];
      const authorities = (
        await c.query(
          'SELECT id,scope_id FROM live_test_sessions WHERE scope_id IN (SELECT scope_id FROM live_test_sessions WHERE id=ANY($1::uuid[])) ORDER BY id FOR NO KEY UPDATE',
          [authorizationIds],
        )
      ).rows;
      await c.query(
        'SELECT id FROM generation_budget_scopes WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE',
        [[...new Set(authorities.map((a) => a.scope_id))].sort()],
      );
      for (const j of jobs) {
        if (j.status === 'running') {
          await this.settleProvider(c, j, null, true);
          await c.query(
            "UPDATE npc_ai_jobs SET status='reconciling',reservation_status=CASE WHEN reservation_status='held' THEN 'released' ELSE reservation_status END,result_code='OUTCOME_UNKNOWN',completed_at=now() WHERE id=$1",
            [j.id],
          );
        } else await this.finalize(c, j.id, j.cancel_requested ? 'cancelled' : 'stale');
      }
      await c.query('DELETE FROM npc_ai_cache WHERE campaign_id=$1 AND expires_at<=now()', [
        campaignId,
      ]);
    });
  }
  /** Trusted operational reconciliation only. No player endpoint. Unknown spend remains counted until evidence arrives. */
  async reconcile(id: string, eventKey: string, actualMicros: number | null) {
    if (actualMicros !== null && (!Number.isSafeInteger(actualMicros) || actualMicros < 0))
      throw new Error('INVALID_USAGE');
    return this.db.tx(async (c) => {
      const existing = (
        await c.query('SELECT * FROM npc_ai_reconciliation WHERE event_key=$1', [eventKey])
      ).rows[0];
      if (existing) {
        if (
          existing.job_id !== id ||
          (existing.actual_micros === null ? null : Number(existing.actual_micros)) !== actualMicros
        )
          fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
        return;
      }
      const j = (await c.query<Job>('SELECT * FROM npc_ai_jobs WHERE id=$1 FOR UPDATE', [id]))
        .rows[0];
      if (!j || j.provider_budget_status !== 'unknown')
        fail(409, 'NOT_RECONCILING', 'NOT_RECONCILING');
      // The explicit full-cost shared receipt below precedes settleProvider; it
      // needs the same provider-before-shared-fence order even with no overrun.
      await c.query('SELECT * FROM npc_ai_provider_budgets WHERE provider_id=$1 FOR UPDATE', [
        j.provider_id,
      ]);
      if (actualMicros !== null) {
        const upper = Number(j.provider_upper_micros);
        const previousOverrun = Math.max(0, Number(j.provider_actual_micros ?? 0) - upper);
        const nextOverrun = Math.max(0, actualMicros - upper);
        if (nextOverrun > 0 || previousOverrun > 0)
          await c.query(
            'UPDATE npc_ai_provider_budgets SET blocked=blocked OR $3,overrun_micros=overrun_micros+$2 WHERE provider_id=$1',
            [
              j.provider_id,
              nextOverrun - previousOverrun,
              !(this.provider instanceof ReleaseGenerationProvider),
            ],
          );
        // The shared ledger has no separate overrun column: retain the entire late bill.
        if (this.provider instanceof ManualLiveProvider)
          await this.provider.session.settleJob(c, j.id, actualMicros, false);
        await this.settleProvider(
          c,
          j,
          this.provider instanceof ReleaseGenerationProvider
            ? actualMicros
            : Math.min(actualMicros, upper),
          false,
        );
        await c.query('UPDATE npc_ai_jobs SET provider_actual_micros=$2 WHERE id=$1', [
          id,
          actualMicros,
        ]);
      }
      await c.query(
        'INSERT INTO npc_ai_reconciliation(job_id,event_key,result,actual_micros) VALUES($1,$2,$3,$4)',
        [id, eventKey, actualMicros === null ? 'still_unknown' : 'settled', actualMicros],
      );
      if (actualMicros !== null)
        await c.query(
          "UPDATE npc_ai_jobs SET status='failed',result_code='RECONCILED_NO_GAME_EFFECT' WHERE id=$1 AND status='reconciling'",
          [id],
        );
    });
  }
}
@Injectable()
export class NpcAiService extends NpcAiEngine implements OnModuleInit, OnModuleDestroy {
  private maintenance?: ReturnType<typeof setInterval>;
  private maintaining = false;
  private lastRetentionAt = 0;
  onModuleInit() {
    this.maintenance = setInterval(() => {
      void this.maintain();
    }, 1000);
    this.maintenance.unref();
  }
  onModuleDestroy() {
    if (this.maintenance) clearInterval(this.maintenance);
  }
  private async maintain() {
    if (this.maintaining) return;
    this.maintaining = true;
    try {
      const rows = await this.db.query<{
        campaign_id: string;
      }>(`SELECT DISTINCT campaign_id FROM npc_ai_jobs
        WHERE status IN ('reserved','running','result_received','validated') AND
        (cancel_requested OR reservation_expires_at<=now() OR (status='running' AND deadline_at<=now()) OR sponsor_id IN (SELECT id FROM npc_ai_sponsors WHERE revoked_at IS NOT NULL OR expires_at<=now()))
        LIMIT 100`);
      for (const row of rows) await this.sweep(row.campaign_id);
      if (Date.now() - this.lastRetentionAt >= 60000) {
        await this.pruneContexts();
        this.lastRetentionAt = Date.now();
      }
      await this.db.query(`DELETE FROM npc_ai_quotes q WHERE id IN
        (SELECT id FROM npc_ai_quotes q2 WHERE expires_at<now()-interval '1 hour'
         AND NOT EXISTS (SELECT 1 FROM npc_ai_jobs j WHERE j.quote_id=q2.id) LIMIT 1000)`);
    } catch {
      /* Retry bounded maintenance next tick; no provider calls or game mutations. */
    } finally {
      this.maintaining = false;
    }
  }
  constructor(@Inject(Db) db: Db, @Inject(GenerationAuthority) live: GenerationAuthority) {
    const configured = readNpcAiConfiguration();
    super(
      db,
      live.mode === 'release'
        ? new ReleaseGenerationProvider(configured.provider, live)
        : live.config.enabled
          ? new ManualLiveProvider(configured.provider, live)
          : configured.provider,
      configured.policy,
    );
  }
}

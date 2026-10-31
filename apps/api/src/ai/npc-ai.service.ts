import { Inject, Injectable, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Db } from '../db';
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
  reservation_status: string;
  reservation_expires_at: Date;
  provider_upper_micros: string;
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
    this.policy = { ...defaults, ...policy };
    for (const value of [
      this.policy.creditPrice,
      this.policy.providerUpperMicros,
      this.policy.providerCapMicros,
    ])
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('INVALID_AI_BUDGET');
    if (
      this.policy.timeoutMs < 10 ||
      this.policy.timeoutMs > 60000 ||
      this.policy.maxQueuedPerCampaign < 1 ||
      this.policy.maxQueuedPerCampaign > 64
    )
      throw new Error('INVALID_AI_LIMITS');
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
  public configuration() {
    return {
      provider: this.provider.external ? 'external' : 'mock',
      enabled: !this.policy.killSwitch && (!this.provider.external || this.policy.externalApproved),
      externalCallsEnabled:
        this.provider.external && this.policy.externalApproved && !this.policy.killSwitch,
      demo: true,
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
  async quote(
    scope: AiScope,
    input: DecisionContext,
    requesterUserId: string,
    client?: PoolClient,
  ) {
    const context = validateDecisionContext(input, this.policy.maxContextBytes);
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
      await c.query(
        `INSERT INTO npc_ai_quotes(id,campaign_id,npc_id,user_id,context_hash,purpose,provider_id,policy_version,credits,upper_micros,expires_at,provider_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          id,
          scope.campaignId,
          scope.npcId,
          requesterUserId,
          context.contextHash,
          scope.purpose ?? 'plan',
          this.provider.id,
          this.policy.version,
          this.policy.creditPrice,
          this.policy.providerUpperMicros,
          expires,
          this.provider.version,
        ],
      );
      return {
        id,
        credits: this.policy.creditPrice,
        expiresAt: expires.toISOString(),
        demo: true,
        requiresConsent: this.policy.creditPrice > 0 || this.provider.external,
        providerUpperMicros: this.policy.providerUpperMicros,
        provider: this.provider.id,
        external: this.provider.external,
        policyVersion: this.policy.version,
      };
    };
    return client ? run(client) : this.db.tx(run);
  }
  private dto(job: Job) {
    return {
      id: job.id,
      npcId: job.npc_id,
      subjectKind: job.subject_kind,
      purpose: job.purpose,
      status: job.status,
      credits: job.credits,
      reservationStatus: job.reservation_status,
      code: job.result_code ?? null,
      createdAt: job.created_at.toISOString(),
      demo: true,
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
      if (this.policy.killSwitch || (this.provider.external && !this.policy.externalApproved))
        fail(503, 'PROVIDER_DISABLED', 'PROVIDER_DISABLED');
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
      if (
        (this.policy.creditPrice > 0 ||
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
          q.credits !== this.policy.creditPrice ||
          Number(q.upper_micros) !== this.policy.providerUpperMicros ||
          new Date(q.expires_at).getTime() <= Date.now()
        )
          fail(409, 'QUOTE_EXPIRED', 'QUOTE_EXPIRED');
        if (
          (await c.query('SELECT 1 FROM npc_ai_jobs WHERE quote_id=$1', [input.quoteId])).rowCount
        )
          fail(409, 'QUOTE_CONSUMED', 'QUOTE_CONSUMED');
        payer = scope.requesterUserId!;
      }
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
      if (payer) {
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
        'INSERT INTO npc_ai_provider_budgets(provider_id,cap_micros) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [this.provider.id, this.policy.providerCapMicros],
      );
      const budget = (
        await c.query('SELECT * FROM npc_ai_provider_budgets WHERE provider_id=$1 FOR UPDATE', [
          this.provider.id,
        ])
      ).rows[0];
      if (budget.blocked) fail(503, 'PROVIDER_DISABLED', 'PROVIDER_DISABLED');
      if (
        Number(budget.reserved_micros) +
          Number(budget.spent_micros) +
          Number(budget.unknown_micros) +
          this.policy.providerUpperMicros >
        Math.min(Number(budget.cap_micros), this.policy.providerCapMicros)
      )
        fail(409, 'PROVIDER_BUDGET_EXCEEDED', 'PROVIDER_BUDGET_EXCEEDED');
      const id = randomUUID();
      const r = await c.query<Job>(
        `INSERT INTO npc_ai_jobs(id,campaign_id,npc_id,operation_id,request_hash,origin,requester_user_id,payer_user_id,purpose,context_hash,context,provider_id,provider_version,policy_version,status,credits,reservation_status,reservation_expires_at,provider_upper_micros,provider_budget_status,quote_id,request_meta,sponsor_id,subject_kind)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'reserved',$15,$16,$17,$18,'reserved',$19,$20,$21,$22) RETURNING *`,
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
          this.policy.creditPrice,
          payer ? 'held' : 'none',
          new Date(Date.now() + this.policy.reservationMs),
          this.policy.providerUpperMicros,
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
        ],
      );
      if (input.runtimeRequestId)
        await c.query(
          "UPDATE game_npc_decision_requests SET status='scheduled',job_id=$2 WHERE id=$1",
          [input.runtimeRequestId, id],
        );
      await c.query(
        'UPDATE npc_ai_provider_budgets SET reserved_micros=reserved_micros+$2 WHERE provider_id=$1',
        [this.provider.id, this.policy.providerUpperMicros],
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
      demo: true,
    };
  }
  async runNext(campaignId: string, isActive: () => Promise<boolean>) {
    if (this.inFlight.has(campaignId)) return;
    this.inFlight.add(campaignId);
    try {
      await this.sweep(campaignId);
      const rows = await this.db.query<Job>(
        "SELECT * FROM npc_ai_jobs WHERE campaign_id=$1 AND status='reserved' AND NOT cancel_requested ORDER BY created_at LIMIT 1",
        [campaignId],
      );
      if (rows[0]) await this.run(rows[0].id, isActive);
    } finally {
      this.inFlight.delete(campaignId);
    }
  }
  async run(id: string, isActive: () => Promise<boolean>) {
    if (this.policy.killSwitch || !(await isActive())) return;
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
        await c.query('UPDATE npc_ai_jobs SET provider_cost_evidence=$2 WHERE id=$1', [
          id,
          result.usage.costEvidence ?? 'reported',
        ]);
        if (result.usage.costMicros > Number(j.provider_upper_micros)) {
          await this.settleProvider(c, j, null, true);
          await c.query(
            'UPDATE npc_ai_provider_budgets SET blocked=true,overrun_micros=overrun_micros+$2 WHERE provider_id=$1',
            [j.provider_id, result.usage.costMicros - Number(j.provider_upper_micros)],
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
          'UPDATE npc_ai_jobs SET provider_request_id=$2,input_tokens=$3,output_tokens=$4,provider_actual_micros=$5 WHERE id=$1',
          [
            id,
            result.requestId,
            result.usage.inputTokens,
            result.usage.outputTokens,
            result.usage.costMicros,
          ],
        );
        if (['cancelled', 'stale', 'failed', 'committed'].includes(j.status)) return;
        if (result.failureCode) {
          if (result.failureCode === 'PROVIDER_LIMIT_VIOLATION')
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
  private async settleProvider(c: PoolClient, j: Job, actual: number | null, unknown: boolean) {
    const upper = Number(j.provider_upper_micros);
    if (j.provider_budget_status === 'reserved') {
      await c.query(
        'UPDATE npc_ai_provider_budgets SET reserved_micros=reserved_micros-$2,spent_micros=spent_micros+$3,unknown_micros=unknown_micros+$4 WHERE provider_id=$1',
        [j.provider_id, upper, unknown ? 0 : (actual ?? 0), unknown ? upper : 0],
      );
    } else if (j.provider_budget_status === 'unknown' && !unknown) {
      await c.query(
        'UPDATE npc_ai_provider_budgets SET unknown_micros=unknown_micros-$2,spent_micros=spent_micros+$3 WHERE provider_id=$1',
        [j.provider_id, upper, actual ?? 0],
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
        "SELECT * FROM npc_ai_jobs WHERE campaign_id=$1 AND status='result_received' AND NOT cancel_requested ORDER BY created_at LIMIT 8",
        [campaignId],
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
    } else if (j.provider_budget_status === 'reserved')
      await this.settleProvider(c, j, j.status === 'running' ? null : 0, j.status === 'running');
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
        "UPDATE npc_ai_jobs j SET cancel_requested=true,result_code='SPONSOR_UNAVAILABLE' FROM npc_ai_sponsors s WHERE j.sponsor_id=s.id AND j.campaign_id=$1 AND (s.revoked_at IS NOT NULL OR s.expires_at<=now()) AND j.status NOT IN ('committed','stale','cancelled','failed')",
        [campaignId],
      );
      const jobs = (
        await c.query<Job>(
          "SELECT * FROM npc_ai_jobs WHERE campaign_id=$1 AND status IN ('reserved','running','result_received','validated') AND (cancel_requested OR reservation_expires_at<=now() OR (status='running' AND deadline_at<=now())) FOR UPDATE",
          [campaignId],
        )
      ).rows;
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
      if (actualMicros !== null) {
        const upper = Number(j.provider_upper_micros);
        const previousOverrun = Math.max(0, Number(j.provider_actual_micros ?? 0) - upper);
        const nextOverrun = Math.max(0, actualMicros - upper);
        if (nextOverrun > 0 || previousOverrun > 0)
          await c.query(
            'UPDATE npc_ai_provider_budgets SET blocked=true,overrun_micros=overrun_micros+$2 WHERE provider_id=$1',
            [j.provider_id, nextOverrun - previousOverrun],
          );
        await this.settleProvider(c, j, Math.min(actualMicros, upper), false);
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
  constructor(@Inject(Db) db: Db) {
    const configured = readNpcAiConfiguration();
    super(db, configured.provider, configured.policy);
  }
}

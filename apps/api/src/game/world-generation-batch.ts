import { aggregateFunding, optionalFunding } from '../generation/currency-funding';
import { totalQuotedSparkSubunits, commonQuotedSparkRate } from '../generation/sparks-quote-total';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient, QueryResultRow } from 'pg';
import type { GameState, StoryQuote } from '@dreamwalk/contracts';
import { matchesTurnFence, turnFence } from '@dreamwalk/game-core';
import { Db } from '../db';
import { NpcAiService } from '../ai/npc-ai.service';
import { digest } from '../ai/context';
import type { AiPurpose } from '../ai/types';
import { fail } from '../errors';
import { sourceAccessSql } from './source-access';

type Entry = {
  requestId: string;
  npcId: string;
  purpose: AiPurpose;
  contextDigest: string;
  originalRequesterId: string | null;
  quote: StoryQuote;
};
const quoteInput = z.object({ operationId: z.uuid() }).strict();
const consentInput = quoteInput.extend({ quoteId: z.uuid(), consent: z.literal(true) }).strict();
const entryIdentity = (rows: QueryResultRow[]) =>
  rows.map((r) => ({
    id: r.id,
    npcId: r.npc_id,
    purpose: r.purpose,
    context: digest(r.context),
    requester: r.requester_user_id,
  }));
/** No generation or wallet holds during quote/consent. The explicit outer quote
 * may preflight image tokens outside these locks; native queue owns every financial hold. */
export class WorldGenerationBatch {
  constructor(
    private readonly db: Db,
    private readonly ai: NpcAiService,
  ) {}
  private async authorize(c: PoolClient, userId: string, campaignId: string) {
    const found = await c.query(
      `SELECT c.id FROM game_campaigns c JOIN users u ON u.id=c.owner_id
      WHERE c.id=$1 AND c.owner_id=$2 AND c.status='active' AND u.deleted_at IS NULL
      AND EXISTS(SELECT 1 FROM game_members m WHERE m.campaign_id=c.id AND m.user_id=$2 AND m.status='accepted')
      AND ${sourceAccessSql('$2')} FOR SHARE OF u,c`,
      [campaignId, userId],
    );
    if (!found.rowCount) fail(403, 'FORBIDDEN', 'FORBIDDEN');
    if (!this.ai.releaseGeneration()) fail(409, 'GENERATION_UNAVAILABLE', 'GENERATION_UNAVAILABLE');
  }
  private async lock(c: PoolClient, campaignId: string) {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `world-generation:${campaignId}`,
    ]);
  }
  private async eligible(
    c: PoolClient,
    userId: string,
    campaignId: string,
    state: GameState,
    lockRows = true,
  ) {
    if (state.turnController?.phase !== 'world') return [];
    const rows = (
      await c.query(
        `SELECT r.* FROM game_npc_decision_requests r
      WHERE r.campaign_id=$1 AND r.status='queued' AND r.job_id IS NULL
      AND (r.requester_user_id IS NULL OR r.requester_user_id=$2)
      AND r.purpose IN ('plan','summary','speech') AND NOT(r.context ? 'storyTurnId')
      AND NOT EXISTS(SELECT 1 FROM live_test_text_permits p WHERE p.request_id=r.id)
      AND NOT EXISTS(SELECT 1 FROM npc_ai_jobs j WHERE j.id=r.job_id OR j.operation_id=r.id OR j.request_meta->>'runtimeRequestId'=r.id::text)
      AND NOT EXISTS(SELECT 1 FROM generation_budget_reservations br WHERE br.operation_key='manual-text:'||r.id::text)
      AND NOT EXISTS(SELECT 1 FROM spark_holds h WHERE h.source_id=r.id::text)
      AND NOT EXISTS(SELECT 1 FROM game_world_generation_batches b WHERE b.campaign_id=$1 AND b.state='accepted'
        AND b.expires_at>now() AND b.turn_fence=$3::jsonb AND b.entries @> jsonb_build_array(jsonb_build_object('requestId',r.id::text)))
      ORDER BY r.created_at,r.id LIMIT 16 ${lockRows ? 'FOR UPDATE OF r' : ''}`,
        [campaignId, userId, JSON.stringify(turnFence(state))],
      )
    ).rows;
    return rows.filter(
      (r) => matchesTurnFence(state, r.context.turnFence) && !r.context.budgetExceeded,
    );
  }
  private async progress(c: PoolClient, campaignId: string) {
    const rows = (
      await c.query(
        `SELECT b.id,b.state,b.expires_at,b.turn_fence,r.id AS request_id,r.status AS request_status,
      COALESCE(r.job_id,j.id) AS job_id,j.status AS job_status,h.status AS hold_status
      FROM game_world_generation_batches b CROSS JOIN LATERAL jsonb_array_elements(b.entries) e
      JOIN game_npc_decision_requests r ON r.id=(e->>'requestId')::uuid
      LEFT JOIN npc_ai_jobs j ON j.id=r.job_id OR j.operation_id=r.id OR j.request_meta->>'runtimeRequestId'=r.id::text LEFT JOIN spark_holds h ON h.id=j.spark_hold_id
      WHERE b.campaign_id=$1 AND b.state IN ('accepted','stale')`,
        [campaignId],
      )
    ).rows;
    const unknown = rows.some((r) => r.job_status === 'reconciling' || r.hold_status === 'pending');
    const active = rows.some((r) =>
      ['queued', 'reserved', 'running', 'result_received', 'validated', 'reconciling'].includes(
        r.job_status,
      ),
    );
    return { rows, unknown, active };
  }
  private async expire(c: PoolClient, campaignId: string, state: GameState) {
    const rows = (
      await c.query(
        "SELECT id,turn_fence,expires_at FROM game_world_generation_batches WHERE campaign_id=$1 AND state='accepted' FOR UPDATE",
        [campaignId],
      )
    ).rows;
    for (const row of rows)
      if (
        !matchesTurnFence(state, row.turn_fence) ||
        new Date(row.expires_at).getTime() <= Date.now()
      )
        await c.query("UPDATE game_world_generation_batches SET state='stale' WHERE id=$1", [
          row.id,
        ]);
  }
  async status(userId: string, campaignId: string, state: GameState) {
    if (!this.ai.releaseGeneration()) return { available: false, pending: false, unknown: false };
    return this.db.tx(async (c) => {
      await this.authorize(c, userId, campaignId);
      const progress = await this.progress(c, campaignId);
      const pending =
        progress.active ||
        progress.unknown ||
        progress.rows.some(
          (r) =>
            r.state === 'accepted' &&
            new Date(r.expires_at).getTime() > Date.now() &&
            matchesTurnFence(state, r.turn_fence) &&
            r.request_status === 'queued' &&
            !r.job_id,
        );
      return {
        available:
          !pending && (await this.eligible(c, userId, campaignId, state, false)).length > 0,
        pending,
        unknown: progress.unknown,
      };
    });
  }
  async quote(userId: string, campaignId: string, state: GameState, body: unknown) {
    const input = quoteInput.parse(body);
    return this.db.tx(async (c) => {
      await this.authorize(c, userId, campaignId);
      await this.lock(c, campaignId);
      await this.expire(c, campaignId, state);
      const old = (
        await c.query(
          'SELECT * FROM game_world_generation_batches WHERE campaign_id=$1 AND owner_id=$2 AND operation_id=$3',
          [campaignId, userId, input.operationId],
        )
      ).rows[0];
      if (
        old &&
        (old.state !== 'quoted' ||
          new Date(old.expires_at).getTime() <= Date.now() ||
          old.state_hash !== digest(state))
      )
        fail(409, 'GENERATION_QUOTE_STALE', 'GENERATION_QUOTE_STALE');
      if (old)
        return {
          status: 'quoted' as const,
          operationId: input.operationId,
          quote: old.quote as StoryQuote,
        };
      const progress = await this.progress(c, campaignId);
      if (
        progress.active ||
        progress.unknown ||
        progress.rows.some(
          (r) => r.state === 'accepted' && r.request_status === 'queued' && !r.job_id,
        )
      )
        fail(409, 'LIVE_OUTCOME_UNRESOLVED', 'LIVE_OUTCOME_UNRESOLVED');
      const requests = await this.eligible(c, userId, campaignId, state);
      if (!requests.length) fail(409, 'LIVE_REQUEST_UNAVAILABLE', 'LIVE_REQUEST_UNAVAILABLE');
      const entries: Entry[] = [];
      for (const r of requests) {
        const quote = await this.ai.quote(
          {
            campaignId,
            npcId: r.npc_id,
            purpose: r.purpose,
            subjectKind: 'npc',
            origin: 'user',
            requesterUserId: userId,
          },
          r.context,
          userId,
          c,
        );
        entries.push({
          requestId: r.id,
          npcId: r.npc_id,
          purpose: r.purpose,
          contextDigest: digest(r.context),
          originalRequesterId: r.requester_user_id,
          quote,
        });
      }
      const reserve = entries.reduce((n, e) => n + (e.quote.providerReserveMicros ?? 0), 0);
      const estimate = entries.reduce(
        (n, e) => n + (e.quote.estimatedTotalMicros ?? e.quote.providerReserveMicros ?? 0),
        0,
      );
      if (
        !Number.isSafeInteger(reserve) ||
        !Number.isSafeInteger(estimate) ||
        reserve <= 0 ||
        estimate <= 0
      )
        fail(409, 'SPARK_PRICE_UNVERIFIED', 'SPARK_PRICE_UNVERIFIED');
      const id = randomUUID(),
        expiresAt = new Date(
          Math.min(...entries.map((e) => Date.parse(e.quote.expiresAt))),
        ).toISOString();
      const quote: StoryQuote = {
        id,
        credits: 0,
        demo: false,
        external: true,
        requiresConsent: true,
        chargeUnit: 'sparks',
        sparkReservedSubunits: totalQuotedSparkSubunits(entries.map((entry) => entry.quote)),
        ...commonQuotedSparkRate(entries.map((entry) => entry.quote)),
        ...optionalFunding(aggregateFunding(entries.map((entry) => entry.quote))),
        providerUpperMicros: null,
        providerReserveMicros: reserve,
        ...(entries.some((e) => e.quote.runtimeMapImages)
          ? {
              runtimeMapImages: entries.reduce((n, e) => n + (e.quote.runtimeMapImages ?? 0), 0),
            }
          : {}),
        estimatedTotalMicros: estimate,
        providerEnforcesQuotedCap: false,
        expiresAt,
        provider: entries[0].quote.provider,
        policyVersion: entries[0].quote.policyVersion,
        estimateSnapshot: {
          schemaVersion: 1,
          costBasis: 'operator_estimate',
          fingerprint: digest(entries),
          reserveMicros: reserve,
          estimatedTotalMicros: estimate,
          providerEnforcesQuotedCap: false,
        },
      };
      await c.query(
        `INSERT INTO game_world_generation_batches(id,campaign_id,owner_id,operation_id,state_hash,request_hash,turn_fence,entries,quote,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id,
          campaignId,
          userId,
          input.operationId,
          digest(state),
          digest(entryIdentity(requests)),
          JSON.stringify(turnFence(state)),
          JSON.stringify(entries),
          JSON.stringify(quote),
          expiresAt,
        ],
      );
      return { status: 'quoted' as const, operationId: input.operationId, quote };
    });
  }
  async consent(userId: string, campaignId: string, state: GameState, body: unknown) {
    const input = consentInput.parse(body);
    return this.db.tx(async (c) => {
      await this.authorize(c, userId, campaignId);
      await this.lock(c, campaignId);
      const batch = (
        await c.query(
          'SELECT * FROM game_world_generation_batches WHERE id=$1 AND campaign_id=$2 AND owner_id=$3 FOR UPDATE',
          [input.quoteId, campaignId, userId],
        )
      ).rows[0];
      if (!batch) fail(404, 'NOT_FOUND', 'NOT_FOUND');
      if (batch.operation_id !== input.operationId)
        fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
      if (batch.accepted_at) {
        const previous = await this.progress(c, campaignId);
        return {
          accepted: true as const,
          pending:
            previous.active ||
            previous.unknown ||
            previous.rows.some(
              (r) =>
                r.id === batch.id &&
                r.state === 'accepted' &&
                r.request_status === 'queued' &&
                !r.job_id,
            ),
        };
      }
      if (
        batch.state !== 'quoted' ||
        new Date(batch.expires_at).getTime() <= Date.now() ||
        batch.state_hash !== digest(state) ||
        !matchesTurnFence(state, batch.turn_fence)
      )
        fail(409, 'GENERATION_QUOTE_STALE', 'GENERATION_QUOTE_STALE');
      const progress = await this.progress(c, campaignId);
      if (
        progress.active ||
        progress.unknown ||
        progress.rows.some(
          (r) => r.state === 'accepted' && r.request_status === 'queued' && !r.job_id,
        )
      )
        fail(409, 'LIVE_OUTCOME_UNRESOLVED', 'LIVE_OUTCOME_UNRESOLVED');
      const requests = await this.eligible(c, userId, campaignId, state);
      if (digest(entryIdentity(requests)) !== batch.request_hash)
        fail(409, 'GENERATION_QUOTE_STALE', 'GENERATION_QUOTE_STALE');
      const entries = batch.entries as Entry[];
      // Every accepted native quote remains exact and unspent; there is no future-request allowance.
      for (const entry of entries) {
        const q = (
          await c.query(
            'SELECT user_id,campaign_id,npc_id,purpose,expires_at,spark_quote_id FROM npc_ai_quotes WHERE id=$1 FOR UPDATE',
            [entry.quote.id],
          )
        ).rows[0];
        if (
          !q ||
          q.user_id !== userId ||
          q.campaign_id !== campaignId ||
          q.npc_id !== entry.npcId ||
          q.purpose !== entry.purpose ||
          !q.spark_quote_id ||
          new Date(q.expires_at).getTime() <= Date.now()
        )
          fail(409, 'GENERATION_QUOTE_STALE', 'GENERATION_QUOTE_STALE');
        if (
          (await c.query('SELECT 1 FROM npc_ai_jobs WHERE quote_id=$1', [entry.quote.id])).rowCount
        )
          fail(409, 'QUOTE_CONSUMED', 'QUOTE_CONSUMED');
      }
      const wallet = (
        await c.query(
          'SELECT enabled,balance_subunits,held_subunits FROM spark_wallets WHERE owner_id=$1 FOR UPDATE',
          [userId],
        )
      ).rows[0];
      if (!wallet?.enabled) fail(409, 'SPARK_WALLET_NOT_ENABLED', 'SPARK_WALLET_NOT_ENABLED');
      const dreams = (
        await c.query(
          'SELECT enabled,balance_subunits,held_subunits FROM dream_wallets WHERE owner_id=$1 FOR UPDATE',
          [userId],
        )
      ).rows[0];
      const dreamAvailable = dreams?.enabled
        ? BigInt(dreams.balance_subunits) - BigInt(dreams.held_subunits)
        : 0n;
      if (
        BigInt(wallet.balance_subunits) - BigInt(wallet.held_subunits) + dreamAvailable <
        BigInt(batch.quote.sparkReservedSubunits)
      )
        fail(409, 'INSUFFICIENT_SPARKS', 'INSUFFICIENT_SPARKS');
      for (const entry of entries)
        await c.query(
          "UPDATE game_npc_decision_requests SET requester_user_id=$2,result_code=NULL WHERE id=$1 AND status='queued' AND job_id IS NULL",
          [entry.requestId, userId],
        );
      await c.query(
        "UPDATE game_world_generation_batches SET state='accepted',accepted_at=now() WHERE id=$1",
        [batch.id],
      );
      return { accepted: true as const, pending: true };
    });
  }
  async quotedWorldRequest(campaignId: string, callerRequest: QueryResultRow) {
    return this.db.tx(async (c) => {
      const candidate = (
        await c.query(
          `SELECT owner_id FROM game_world_generation_batches WHERE campaign_id=$1 AND state='accepted'
        AND entries @> jsonb_build_array(jsonb_build_object('requestId',$2::text)) ORDER BY accepted_at DESC LIMIT 1`,
          [campaignId, callerRequest.id],
        )
      ).rows[0];
      if (!candidate) return null;
      await this.authorize(c, candidate.owner_id, campaignId);
      await this.lock(c, campaignId);
      const batch = (
        await c.query(
          `SELECT * FROM game_world_generation_batches WHERE campaign_id=$1 AND state='accepted'
        AND entries @> jsonb_build_array(jsonb_build_object('requestId',$2::text)) ORDER BY accepted_at DESC LIMIT 1 FOR UPDATE`,
          [campaignId, callerRequest.id],
        )
      ).rows[0];
      if (!batch) return null;
      const progress = await this.progress(c, campaignId);
      if (progress.unknown || progress.active) return null;
      const request = (
        await c.query(
          'SELECT * FROM game_npc_decision_requests WHERE id=$1 AND campaign_id=$2 FOR UPDATE',
          [callerRequest.id, campaignId],
        )
      ).rows[0];
      const state = (await c.query('SELECT state FROM game_campaigns WHERE id=$1', [campaignId]))
        .rows[0]?.state;
      const entry = (batch.entries as Entry[]).find((e) => e.requestId === callerRequest.id)!;
      if (
        progress.rows.some(
          (r) => r.id === batch.id && ['failed', 'stale', 'cancelled'].includes(r.job_status),
        ) ||
        !request ||
        request.status !== 'queued' ||
        request.job_id ||
        !state ||
        !matchesTurnFence(state, batch.turn_fence) ||
        new Date(batch.expires_at).getTime() <= Date.now() ||
        digest(request.context) !== entry.contextDigest ||
        digest(callerRequest.context) !== entry.contextDigest ||
        request.requester_user_id !== batch.owner_id
      ) {
        await c.query("UPDATE game_world_generation_batches SET state='stale' WHERE id=$1", [
          batch.id,
        ]);
        return null;
      }
      return {
        quote: entry.quote,
        request: {
          id: request.id,
          npcId: request.npc_id,
          purpose: request.purpose,
          context: request.context,
          requesterUserId: batch.owner_id,
        },
        batchId: batch.id,
      };
    });
  }
  async invalidate(campaignId: string, requestId: string) {
    await this.db.query(
      `UPDATE game_world_generation_batches SET state='stale' WHERE campaign_id=$1 AND state='accepted'
      AND entries @> jsonb_build_array(jsonb_build_object('requestId',$2::text))`,
      [campaignId, requestId],
    );
  }
}

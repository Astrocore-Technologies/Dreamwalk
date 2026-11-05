import {
  worldKnownCostPolicyHash,
  worldKnownCostPolicyRequired,
  acceptedWorldKnownCostPolicyMatches,
} from '../generation/known-cost-policy';
import { LocationTravelGeneration } from './location-travel-generation';
import { captureWorldQuoteRoster } from '../ai/runtime-map-preflight';
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
const quoteInput = z
  .object({
    operationId: z.uuid(),
    automaticKnownCostPolicy: z.literal('known-cost-v1').optional(),
  })
  .strict();
const consentInput = quoteInput
  .extend({
    quoteId: z.uuid(),
    consent: z.literal(true),
    estimateRiskConsent: z.literal(true).optional(),
    automaticKnownCostPolicyHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
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
    private readonly travel?: LocationTravelGeneration,
  ) {}
  private async authorize(
    c: PoolClient,
    userId: string,
    campaignId: string,
    requireRelease = true,
  ) {
    const found = await c.query(
      `SELECT c.id FROM game_campaigns c JOIN users u ON u.id=c.owner_id
      WHERE c.id=$1 AND c.owner_id=$2 AND c.status='active' AND u.deleted_at IS NULL
      AND EXISTS(SELECT 1 FROM game_members m WHERE m.campaign_id=c.id AND m.user_id=$2 AND m.status='accepted')
      AND ${sourceAccessSql('$2')} FOR SHARE OF u,c`,
      [campaignId, userId],
    );
    if (!found.rowCount) fail(403, 'FORBIDDEN', 'FORBIDDEN');
    if (requireRelease && !this.ai.releaseGeneration())
      fail(409, 'GENERATION_UNAVAILABLE', 'GENERATION_UNAVAILABLE');
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
      AND (r.requester_user_id IS NULL OR r.requester_user_id=$2 OR r.context->>'generationPolicy'='world-batch-v1')
      AND r.purpose IN ('plan','summary','speech','story_turn')
      AND (NOT(r.context ? 'storyTurnId') OR r.context->>'generationPolicy'='world-batch-v1')
      AND NOT EXISTS(SELECT 1 FROM live_test_text_permits p WHERE p.request_id=r.id)
      AND NOT EXISTS(SELECT 1 FROM npc_ai_jobs j WHERE j.id=r.job_id OR j.operation_id=r.id OR j.request_meta->>'runtimeRequestId'=r.id::text)
      AND NOT EXISTS(SELECT 1 FROM generation_budget_reservations br WHERE br.operation_key='manual-text:'||r.id::text)
      AND NOT EXISTS(SELECT 1 FROM spark_holds h WHERE h.source_id=r.id::text)
      AND NOT EXISTS(SELECT 1 FROM game_world_generation_batches accepted WHERE accepted.campaign_id=$1
        AND accepted.accepted_at IS NOT NULL
        AND (r.context ? 'worldRoundDecision' OR r.context->>'generationPolicy'='world-batch-v1')
        AND accepted.entries @> jsonb_build_array(jsonb_build_object('requestId',r.id::text)))
      AND NOT EXISTS(SELECT 1 FROM game_world_generation_batches b WHERE b.campaign_id=$1 AND b.state='accepted'
        AND b.expires_at>now() AND b.turn_fence=$3::jsonb AND b.entries @> jsonb_build_array(jsonb_build_object('requestId',r.id::text)))
      ORDER BY CASE WHEN r.purpose='story_turn' THEN 0 WHEN r.purpose='speech' THEN 1 ELSE 2 END,r.created_at,r.id ${lockRows ? 'FOR UPDATE OF r' : ''}`,
        [campaignId, userId, JSON.stringify(turnFence(state))],
      )
    ).rows;
    // A quote is the entire round, never a silent subset with missing oversized bodies.
    if (rows.some((r) => r.context.budgetExceeded))
      fail(413, 'CONTEXT_BUDGET_EXCEEDED', 'CONTEXT_BUDGET_EXCEEDED');
    if (
      rows.some(
        (r) =>
          (r.context.worldRoundDecision || r.context.generationPolicy === 'world-batch-v1') &&
          !matchesTurnFence(state, r.context.turnFence),
      )
    )
      fail(409, 'GENERATION_QUOTE_STALE', 'GENERATION_QUOTE_STALE');
    return rows.filter((r) => matchesTurnFence(state, r.context.turnFence));
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
    const media = await this.travel?.progress(c, campaignId);
    return {
      rows,
      mediaRows: media?.rows ?? [],
      unknown: unknown || !!media?.unknown,
      active: active || !!media?.active,
    };
  }
  private async expire(c: PoolClient, campaignId: string, state: GameState) {
    const rows = (
      await c.query(
        "SELECT id,turn_fence,expires_at,entries FROM game_world_generation_batches WHERE campaign_id=$1 AND state='accepted' FOR UPDATE",
        [campaignId],
      )
    ).rows;
    for (const row of rows)
      if (!matchesTurnFence(state, row.turn_fence)) {
        await c.query("UPDATE game_world_generation_batches SET state='stale' WHERE id=$1", [
          row.id,
        ]);
        for (const entry of row.entries as Entry[]) {
          const context = (
            await c.query('SELECT context FROM game_npc_decision_requests WHERE id=$1', [
              entry.requestId,
            ])
          ).rows[0]?.context;
          if (context?.worldRoundDecision || context?.generationPolicy === 'world-batch-v1')
            await this.failUnspent(campaignId, entry.requestId, 'WORLD_QUOTE_STALE', c);
        }
      }
  }
  /** Read-only signal from the already committed free post, before any media quote. */
  async pendingLocationCount(c: Pick<PoolClient, 'query'>, campaignId: string, state: GameState) {
    if (state.turnController?.phase !== 'world') return 0;
    const result = await c.query(
      `SELECT count(*)::int AS count FROM game_npc_decision_requests r
       JOIN game_story_turns t ON t.id=r.id AND t.campaign_id=r.campaign_id
       WHERE r.campaign_id=$1 AND r.purpose='story_turn' AND r.status='queued' AND r.job_id IS NULL
       AND t.status='committed' AND t.erased_at IS NULL AND t.context ? 'travelOriginMapId'
       AND t.input->'turnFence'->>'roundId'=$2`,
      [campaignId, state.turnController.roundId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }
  async declineLocations(userId: string, campaignId: string, state: GameState, body: unknown) {
    const input = z
      .object({ requestIds: z.array(z.uuid()).min(1).max(256) })
      .strict()
      .parse(body);
    const ids = [...new Set(input.requestIds)].sort();
    return this.db.tx(async (c) => {
      await this.authorize(c, userId, campaignId, false);
      await this.lock(c, campaignId);
      const rows = (
        await c.query(
          `SELECT t.id,t.input,r.status,r.result_code,r.job_id
        FROM game_story_turns t JOIN game_npc_decision_requests r ON r.id=t.id AND r.campaign_id=t.campaign_id
        WHERE t.campaign_id=$1 AND t.id=ANY($2::uuid[]) AND t.erased_at IS NULL AND t.status='committed'
        AND t.context ? 'travelOriginMapId' AND r.purpose='story_turn' FOR UPDATE OF t,r`,
          [campaignId, ids],
        )
      ).rows;
      if (rows.length !== ids.length)
        fail(409, 'LOCATION_TRAVEL_UNAVAILABLE', 'LOCATION_TRAVEL_UNAVAILABLE');
      for (const row of rows) {
        if (row.status === 'cancelled' && row.result_code === 'LOCATION_TRAVEL_DECLINED') continue;
        const prep = (
          await c.query('SELECT * FROM game_location_travel_preparations WHERE id=$1 FOR UPDATE', [
            row.id,
          ])
        ).rows[0];
        if (
          row.status !== 'queued' ||
          row.job_id ||
          (prep &&
            (prep.owner_id !== userId ||
              prep.campaign_id !== campaignId ||
              prep.state !== 'prepared' ||
              prep.image_job_id))
        )
          fail(409, 'LOCATION_TRAVEL_ALREADY_STARTED', 'LOCATION_TRAVEL_ALREADY_STARTED');
        const changed = await c.query(
          `UPDATE game_npc_decision_requests r SET status='cancelled',result_code='LOCATION_TRAVEL_DECLINED'
          WHERE r.id=$1 AND r.campaign_id=$2 AND r.status='queued' AND r.job_id IS NULL
          AND NOT EXISTS(SELECT 1 FROM npc_ai_jobs j WHERE j.operation_id=r.id OR j.request_meta->>'runtimeRequestId'=r.id::text)
          AND NOT EXISTS(SELECT 1 FROM live_test_text_permits p WHERE p.request_id=r.id)
          AND NOT EXISTS(SELECT 1 FROM generation_budget_reservations b WHERE b.operation_key='manual-text:'||r.id::text)
          AND NOT EXISTS(SELECT 1 FROM spark_holds h WHERE h.source_id=r.id::text)
          AND NOT EXISTS(SELECT 1 FROM image_generation_jobs j WHERE j.operation_id=r.id AND j.actor_id=$3)
          RETURNING id`,
          [row.id, campaignId, userId],
        );
        if (!changed.rowCount)
          fail(409, 'LOCATION_TRAVEL_ALREADY_STARTED', 'LOCATION_TRAVEL_ALREADY_STARTED');
        await c.query(
          "UPDATE game_location_travel_preparations SET state='failed' WHERE id=$1 AND state='prepared'",
          [row.id],
        );
        await c.query(
          "UPDATE game_story_turns SET result_code='LOCATION_TRAVEL_DECLINED' WHERE id=$1",
          [row.id],
        );
      }
      await c.query(
        `UPDATE game_world_generation_batches SET state='stale' WHERE campaign_id=$1 AND accepted_at IS NULL
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(media_entries) e WHERE e->>'preparationId'=ANY($2::text[]))`,
        [campaignId, ids],
      );
      if ((await this.pendingLocationCount(c, campaignId, state)) === 0) {
        const rounds = [
          ...new Set(rows.map((row) => row.input.turnFence?.roundId).filter(Boolean)),
        ];
        // The original End turn already authorized ordinary text. Restore only that exact blocked round.
        await c.query(
          `UPDATE game_ordinary_round_consents SET state='pending',result_code=NULL,updated_at=now()
          WHERE campaign_id=$1 AND owner_id=$2 AND round_id=ANY($3::text[]) AND state='blocked'
          AND result_code='IMAGE_ESTIMATE_RISK_CONSENT_REQUIRED'`,
          [campaignId, userId, rounds],
        );
      }
      return { declined: true as const, requestIds: ids };
    });
  }
  async status(userId: string, campaignId: string, state: GameState) {
    return this.db.tx(async (c) => {
      await this.authorize(c, userId, campaignId, false);
      const generatedLocationImages = await this.pendingLocationCount(c, campaignId, state);
      const pendingLocationIds = generatedLocationImages
        ? (
            await c.query(
              `SELECT t.id FROM game_story_turns t
        JOIN game_npc_decision_requests r ON r.id=t.id AND r.campaign_id=t.campaign_id
        WHERE t.campaign_id=$1 AND t.context ? 'travelOriginMapId' AND t.status='committed' AND t.erased_at IS NULL
        AND r.purpose='story_turn' AND r.status='queued' AND r.job_id IS NULL AND t.input->'turnFence'->>'roundId'=$2
        ORDER BY t.id`,
              [campaignId, state.turnController?.roundId],
            )
          ).rows.map((row) => String(row.id))
        : [];
      // Metadata only: reading a waiting reason must not quote, admit, cancel or retry work.
      const waiting = await c.query(
        `SELECT r.result_code FROM game_npc_decision_requests r LEFT JOIN npc_ai_jobs j ON j.id=r.job_id
        WHERE r.campaign_id=$1 AND (r.status='queued' OR (r.status='scheduled' AND
          (j.id IS NULL OR j.status IN ('queued','reserved','running','result_received','validated'))))`,
        [campaignId],
      );
      if (!this.ai.releaseGeneration()) {
        const evidence = (
          await c.query(
            `SELECT EXISTS(SELECT 1 FROM npc_ai_jobs j LEFT JOIN spark_holds h ON h.id=j.spark_hold_id
             WHERE j.campaign_id=$1 AND (j.status='reconciling' OR h.status='pending'))
             OR EXISTS(SELECT 1 FROM live_test_text_permits p WHERE p.campaign_id=$1 AND p.state='unknown')
             OR EXISTS(SELECT 1 FROM game_npc_decision_requests r JOIN spark_holds h ON h.source_id=r.id::text
               WHERE r.campaign_id=$1 AND h.status='pending') AS unknown,
           EXISTS(SELECT 1 FROM npc_ai_jobs j WHERE j.campaign_id=$1 AND
             j.status IN ('queued','reserved','running','result_received','validated')) AS active`,
            [campaignId],
          )
        ).rows[0];
        const unknown = evidence.unknown === true,
          active = evidence.active === true;
        return {
          available: false,
          generatedLocationImages,
          pendingLocationIds,
          estimateRiskConsentRequired: generatedLocationImages > 0,
          pending: unknown || active,
          unknown,
          reason: unknown
            ? 'outcome_unknown'
            : active
              ? 'processing'
              : waiting.rows.some((r) => r.result_code === 'MANUAL_AUTHORIZATION_UNAVAILABLE')
                ? 'manual_authorization_required'
                : waiting.rowCount
                  ? 'unavailable'
                  : 'no_pending_generation',
        };
      }
      const progress = await this.progress(c, campaignId);
      const pending =
        progress.active ||
        progress.unknown ||
        progress.rows.some(
          (r) =>
            r.state === 'accepted' &&
            matchesTurnFence(state, r.turn_fence) &&
            r.request_status === 'queued' &&
            !r.job_id,
        );
      // The free departure can precede world context preparation. Its explicit
      // quote endpoint will prepare the round; GET must neither schedule it nor
      // reject a still-unprepared intent as a stale paid quote.
      const available =
        !pending &&
        (generatedLocationImages > 0 ||
          (await this.eligible(c, userId, campaignId, state, false)).length > 0);
      return {
        available,
        generatedLocationImages,
        pendingLocationIds,
        estimateRiskConsentRequired: generatedLocationImages > 0,
        pending,
        unknown: progress.unknown,
        reason: progress.unknown
          ? 'outcome_unknown'
          : pending
            ? 'processing'
            : available
              ? 'awaiting_consent'
              : waiting.rowCount
                ? 'unavailable'
                : 'no_pending_generation',
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
      const quoteRoster = captureWorldQuoteRoster(c, userId, campaignId, requests);
      for (const r of requests) {
        const quote = await this.ai.quote(
          {
            campaignId,
            npcId: r.npc_id,
            purpose: r.purpose,
            subjectKind: r.purpose === 'story_turn' ? 'player' : 'npc',
            origin: 'user',
            requesterUserId: userId,
          },
          r.context,
          userId,
          c,
          r.context.worldRoundDecision || r.context.generationPolicy === 'world-batch-v1'
            ? String(r.id)
            : undefined,
          r.context.worldRoundDecision || r.context.generationPolicy === 'world-batch-v1'
            ? quoteRoster
            : undefined,
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
      const mediaEntries =
        (await this.travel?.quotes(
          c,
          userId,
          campaignId,
          requests.map((r) => String(r.id)),
        )) ?? [];
      if (
        requests.some(
          (r) =>
            r.context.travelRequests?.some((t: { mapId?: string | null }) => !t.mapId) &&
            !mediaEntries.some((entry) => entry.preparationId === r.id),
        )
      )
        fail(409, 'LOCATION_MEDIA_UNAVAILABLE', 'LOCATION_MEDIA_UNAVAILABLE');
      const pricedEntries = [...entries, ...mediaEntries];
      const reserve = pricedEntries.reduce((n, e) => n + (e.quote.providerReserveMicros ?? 0), 0);
      const estimate = pricedEntries.reduce(
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
          Math.min(...pricedEntries.map((e) => Date.parse(e.quote.expiresAt))),
        ).toISOString();
      // Never publish a dead aggregate after a slow exact-quote pass. Rollback
      // every native quote together; no consent, job or hold was created.
      if (Date.parse(expiresAt) <= Date.now())
        fail(409, 'GENERATION_QUOTE_STALE', 'GENERATION_QUOTE_STALE');
      const quote: StoryQuote = {
        id,
        ...(input.automaticKnownCostPolicy === 'known-cost-v1' ||
        mediaEntries.some((entry) => entry.automaticKnownCostPolicyHash)
          ? {
              automaticKnownCostPolicy: 'known-cost-v1' as const,
              automaticKnownCostPolicyHash: worldKnownCostPolicyHash(entries, mediaEntries),
            }
          : {}),
        credits: 0,
        demo: false,
        external: true,
        requiresConsent: true,
        chargeUnit: 'sparks',
        sparkReservedSubunits: totalQuotedSparkSubunits(pricedEntries.map((entry) => entry.quote)),
        ...commonQuotedSparkRate(pricedEntries.map((entry) => entry.quote)),
        ...optionalFunding(aggregateFunding(pricedEntries.map((entry) => entry.quote))),
        ...(mediaEntries.length
          ? { generatedLocationImages: mediaEntries.length, estimateRiskConsentRequired: true }
          : {}),
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
          fingerprint: digest(pricedEntries),
          reserveMicros: reserve,
          estimatedTotalMicros: estimate,
          providerEnforcesQuotedCap: false,
        },
      };
      await c.query(
        `INSERT INTO game_world_generation_batches(id,campaign_id,owner_id,operation_id,state_hash,request_hash,turn_fence,entries,quote,expires_at,media_entries)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
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
          JSON.stringify(mediaEntries),
        ],
      );
      return { status: 'quoted' as const, operationId: input.operationId, quote };
    });
  }
  private async consumeOrdinaryForMedia(c: PoolClient, batch: QueryResultRow, userId: string) {
    if (!Array.isArray(batch.media_entries) || !batch.media_entries.length) return;
    // Explicit combined consent supersedes the same round's text-only intent.
    // Persist this in the acceptance transaction, before a worker can schedule media/text.
    await c.query(
      `UPDATE game_ordinary_round_consents SET state='accepted',batch_id=$3,result_code=NULL,updated_at=now()
       WHERE campaign_id=$1 AND round_id=$2 AND owner_id=$4 AND state IN ('pending','blocked')
       AND (result_code IS NULL OR result_code='IMAGE_ESTIMATE_RISK_CONSENT_REQUIRED')`,
      [batch.campaign_id, batch.turn_fence.roundId, batch.id, userId],
    );
  }
  async consent(
    userId: string,
    campaignId: string,
    state: GameState,
    body: unknown,
    ordinaryRoundId?: string,
  ) {
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
      // This argument is server-only. Public request bodies cannot stamp this
      // policy or authorize a future round, another payer, or image generation.
      if (ordinaryRoundId !== undefined) {
        const authority = (
          await c.query(
            `SELECT 1 FROM game_ordinary_round_consents
           WHERE campaign_id=$1 AND round_id=$2 AND owner_id=$3 AND operation_id=$4
           AND state IN ('pending','accepted') FOR UPDATE`,
            [campaignId, ordinaryRoundId, userId, input.operationId],
          )
        ).rows[0];
        if (
          !authority ||
          state.turnController?.phase !== 'world' ||
          state.turnController.roundId !== ordinaryRoundId ||
          batch.turn_fence?.roundId !== ordinaryRoundId
        )
          fail(409, 'ORDINARY_ROUND_NOT_AUTHORIZED', 'ORDINARY_ROUND_NOT_AUTHORIZED');
        if (
          batch.quote.generatedLocationImages > 0 ||
          batch.quote.estimateRiskConsentRequired ||
          (Array.isArray(batch.media_entries) && batch.media_entries.length > 0) ||
          !(batch.entries as Entry[]).every((entry) =>
            ['plan', 'summary', 'speech', 'story_turn'].includes(entry.purpose),
          )
        )
          fail(409, 'IMAGE_ESTIMATE_RISK_CONSENT_REQUIRED', 'IMAGE_ESTIMATE_RISK_CONSENT_REQUIRED');
      }
      if (batch.accepted_at) {
        await this.consumeOrdinaryForMedia(c, batch, userId);
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
      if (worldKnownCostPolicyRequired(batch)) {
        if (
          !acceptedWorldKnownCostPolicyMatches(batch) ||
          input.automaticKnownCostPolicyHash !== batch.quote.automaticKnownCostPolicyHash
        )
          fail(
            409,
            'IMAGE_SETTLEMENT_POLICY_CONSENT_REQUIRED',
            'IMAGE_SETTLEMENT_POLICY_CONSENT_REQUIRED',
          );
      } else if (input.automaticKnownCostPolicyHash) {
        fail(409, 'IMAGE_SETTLEMENT_POLICY_MISMATCH', 'IMAGE_SETTLEMENT_POLICY_MISMATCH');
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
      if (Array.isArray(batch.media_entries) && batch.media_entries.length)
        await this.travel?.accept(
          c,
          userId,
          batch.id,
          batch.media_entries,
          input.estimateRiskConsent === true,
        );
      for (const entry of entries)
        await c.query(
          "UPDATE game_npc_decision_requests SET requester_user_id=$2,result_code=NULL WHERE id=$1 AND status='queued' AND job_id IS NULL",
          [entry.requestId, userId],
        );
      await c.query(
        "UPDATE game_world_generation_batches SET state='accepted',accepted_at=now(),quote=$2::jsonb WHERE id=$1",
        [
          batch.id,
          JSON.stringify(
            ordinaryRoundId === undefined
              ? batch.quote
              : {
                  ...batch.quote,
                  ordinaryTurnConsentVersion: 'end-turn-v1',
                },
          ),
        ],
      );
      await this.consumeOrdinaryForMedia(c, batch, userId);
      if (ordinaryRoundId !== undefined)
        await c.query(
          `UPDATE game_ordinary_round_consents SET state='accepted',batch_id=$3,updated_at=now()
           WHERE campaign_id=$1 AND round_id=$2 AND state='pending'`,
          [campaignId, ordinaryRoundId, batch.id],
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
      if (worldKnownCostPolicyRequired(batch) && !acceptedWorldKnownCostPolicyMatches(batch))
        fail(409, 'WORLD_BATCH_CONSENT_STALE', 'WORLD_BATCH_CONSENT_STALE');
      let progress = await this.progress(c, campaignId);
      if (!progress.active && !progress.unknown) {
        await this.travel?.advance(c, batch.owner_id, campaignId, batch.id, callerRequest.id);
        progress = await this.progress(c, campaignId);
      }
      if (progress.unknown) {
        // Stop unpaid siblings, not the unresolved financial evidence. A player
        // must not remain trapped in this phase or buy replacement work.
        for (const unpaid of batch.entries as Entry[]) {
          const context = (
            await c.query('SELECT context FROM game_npc_decision_requests WHERE id=$1', [
              unpaid.requestId,
            ])
          ).rows[0]?.context;
          if (context?.worldRoundDecision || context?.generationPolicy === 'world-batch-v1')
            await this.failUnspent(
              campaignId,
              unpaid.requestId,
              'WORLD_PROVIDER_OUTCOME_UNKNOWN',
              c,
            );
        }
        return null;
      }
      const failedImage = progress.mediaRows.find(
        (row) =>
          row.id === callerRequest.id && ['rejected', 'cancelled', 'expired'].includes(row.status),
      );
      if (failedImage) {
        await this.failUnspent(campaignId, callerRequest.id, 'LOCATION_IMAGE_FAILED', c);
        return null;
      }
      if (progress.active) return null;
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
        (!(
          request?.context.worldRoundDecision ||
          request?.context.generationPolicy === 'world-batch-v1'
        ) &&
          progress.rows.some(
            (r) => r.id === batch.id && ['failed', 'stale', 'cancelled'].includes(r.job_status),
          )) ||
        !request ||
        request.status !== 'queued' ||
        request.job_id ||
        !state ||
        !matchesTurnFence(state, batch.turn_fence) ||
        digest(request.context) !== entry.contextDigest ||
        digest(callerRequest.context) !== entry.contextDigest ||
        request.requester_user_id !== batch.owner_id
      ) {
        await c.query("UPDATE game_world_generation_batches SET state='stale' WHERE id=$1", [
          batch.id,
        ]);
        for (const unpaid of batch.entries as Entry[]) {
          const candidate = await c.query(
            'SELECT context FROM game_npc_decision_requests WHERE id=$1',
            [unpaid.requestId],
          );
          const context = candidate.rows[0]?.context;
          if (context?.worldRoundDecision || context?.generationPolicy === 'world-batch-v1')
            await this.failUnspent(campaignId, unpaid.requestId, 'WORLD_QUOTE_STALE', c);
        }
        return null;
      }
      return {
        quote: entry.quote,
        request: {
          id: request.id,
          npcId: request.npc_id,
          purpose: request.purpose as AiPurpose,
          causeKey: String(request.cause_key),
          context: request.context,
          requesterUserId: batch.owner_id,
        },
        batchId: batch.id,
        ...(acceptedWorldKnownCostPolicyMatches(batch)
          ? { automaticKnownCostPolicy: 'known-cost-v1' as const }
          : {}),
      };
    });
  }
  /** An unresolved prior round must not create a new charge or strand later rounds. */
  async stopUnspentForUnknown(campaignId: string) {
    const unknown = await this.db.query(
      `SELECT 1 FROM npc_ai_jobs j LEFT JOIN spark_holds h ON h.id=j.spark_hold_id
       WHERE j.campaign_id=$1 AND (j.status='reconciling' OR h.status='pending')
       UNION ALL SELECT 1 FROM live_test_text_permits WHERE campaign_id=$1 AND state='unknown'
       UNION ALL SELECT 1 FROM game_location_travel_preparations p JOIN image_generation_jobs j ON j.id=p.image_job_id
         LEFT JOIN spark_holds h ON h.id=j.spark_quote_id WHERE p.campaign_id=$1 AND (j.status='unknown' OR h.status='pending') LIMIT 1`,
      [campaignId],
    );
    if (!unknown.length) return;
    const unpaid = await this.db.query(
      "SELECT id FROM game_npc_decision_requests WHERE campaign_id=$1 AND status='queued' AND (context ? 'worldRoundDecision' OR context->>'generationPolicy'='world-batch-v1')",
      [campaignId],
    );
    for (const request of unpaid)
      await this.failUnspent(campaignId, request.id, 'WORLD_PROVIDER_OUTCOME_UNKNOWN');
  }
  /** Terminalize only a proven-unspent request; never erase a permit, hold or uncertain liability. */
  async failUnspent(campaignId: string, requestId: string, code: string, client?: PoolClient) {
    const sql = `UPDATE game_npc_decision_requests r SET status='failed',result_code=$3
      WHERE r.campaign_id=$1 AND r.id=$2 AND r.status='queued' AND r.job_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM npc_ai_jobs j WHERE j.operation_id=r.id OR j.request_meta->>'runtimeRequestId'=r.id::text)
      AND NOT EXISTS(SELECT 1 FROM live_test_text_permits p WHERE p.request_id=r.id)
      AND NOT EXISTS(SELECT 1 FROM generation_budget_reservations b WHERE b.operation_key='manual-text:'||r.id::text)
      AND NOT EXISTS(SELECT 1 FROM spark_holds h WHERE h.source_id=r.id::text)`;
    if (client) await client.query(sql, [campaignId, requestId, code]);
    else await this.db.query(sql, [campaignId, requestId, code]);
  }
  async invalidate(campaignId: string, requestId: string) {
    await this.db.query(
      `UPDATE game_world_generation_batches SET state='stale' WHERE campaign_id=$1 AND state='accepted'
      AND entries @> jsonb_build_array(jsonb_build_object('requestId',$2::text))`,
      [campaignId, requestId],
    );
  }
}

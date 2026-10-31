import { mediaPreparationSchema, prepareSceneMedia } from './media-preparation';
import { readOwnedHero, pinHero } from './hero-selection';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { config } from '../config';
import { AssetReuseService } from '../assets/reuse.service';
import { ImageGenerationService } from '../image-generation/service';
import { semanticGameProjection } from './projection-clock';
import { pruneNpcMemory } from './npc-retention';
import { recordNpcMetric } from './npc-telemetry';
import { Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import {
  gameActionSchema,
  gameHeroSelectionSchema,
  gameIntentSchema,
  gameMoveSchema,
  npcSpeechSchema,
  type GameState,
  type GameResult,
  type GameProjection,
} from '@dreamwalk/contracts';
import {
  createObservatoryState,
  advanceObjectives,
  buildNarrativeContext,
  createMockNarrativeProposal,
  applyNarrativeProposal,
  addPlayer,
  tick,
  moveInput,
  stopMovement,
  applyAction,
  beginEncounter,
  requestEncounterJoin,
  requestEncounterEnd,
  submitIntent,
  resolveRound,
  projectState,
  mockNpcDecision,
  validateNpcProposal,
  createMockNpcPlan,
  acceptNpcPlan,
  stepNpcPlan,
  stepLivingNpcs,
  applyNpcSpeech,
  projectGameEvents,
  buildNpcDecisionContext,
  createNpcMemorySummary,
  createNpcMemorySummarySelection,
  acceptNpcMemorySummary,
  buildNpcPublicSpeechContext,
  admittedNpcSpeechObservationId,
  npcReplyObservation,
  commitNpcPublicUtterance,
  canNpcHear,
  npcContextFingerprint,
  recordNpcEvents,
  respondNpcObligation,
  resolveNpcFactTopic,
  createMockNpcPublicResponse,
  proposePlayerTextIntent,
  proposePlayerActionIntent,
  confirmPlayerTextIntent,
} from '@dreamwalk/game-core';
import { Db } from '../db';
import { NpcAiService } from '../ai/npc-ai.service';
import { packNpcContext } from './npc-context-budget';
import type { ReadyDecision, AiPurpose } from '../ai/types';
import { insertNpcRequest, type NpcDecisionRequest } from './npc-requests';
import { archiveNpcEpisodes, recallNpcEpisodes } from './npc-memory';
import { Auth } from '../auth';
import { fail } from '../errors';
import { PlayableService, sourceAccessSql, sourceLiveSql } from './playable.service';

export const commandSchema = z
  .object({
    protocolVersion: z.literal(1),
    operationId: z.uuid(),
    npcId: z
      .string()
      .regex(/^[\w-]+$/)
      .max(100)
      .optional(),
    type: z.enum([
      'action',
      'encounter.begin',
      'encounter.intent',
      'encounter.join',
      'encounter.end',
      'npc.request',
      'npc.speech',
      'npc.promise',
      'intent.confirm',
    ]),
    encounterId: z
      .string()
      .regex(/^[\w-]+$/)
      .max(100)
      .optional(),
    action: gameActionSchema.optional(),
    speech: npcSpeechSchema.optional(),
    topicId: z
      .string()
      .regex(/^[\w-]+$/)
      .max(100)
      .optional(),
    proposalId: z.uuid().optional(),
    promiseId: z.string().min(1).max(200).optional(),
    decision: z.enum(['accept', 'decline']).optional(),
    intent: gameIntentSchema.optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
export const moveSchema = gameMoveSchema.extend({ connectionEpoch: z.number().int() }).strict();
type Command = z.infer<typeof commandSchema>;
type RuntimeClock = {
  paused: boolean;
  capturedAtMs: number;
  rounds: Record<string, number>;
  jobs: Record<string, { dueMs: number; deadlineMs: number }>;
};
type Live = {
  state: GameState;
  dbRevision: number;
  eventSeq: number;
  dirty: boolean;
  lastCheckpoint: number;
  lastAccess: number;
  epoch: number;
  actorEpochs: Record<string, number>;
  npcPending: boolean;
  aiPending: boolean;
  decisionsPending: boolean;
  deferredNpcIds: string[];
  lastRetentionTick: number;
  paused: boolean;
  clock: RuntimeClock;
  presence: Map<string, number>;
  campaign: {
    title: string | null;
    playableVersionId: string | null;
    sourceRevision: number | null;
  };
};
const digest = (v: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(v)))
    .digest('hex');
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
@Injectable()
export class GameService implements OnModuleDestroy {
  private live = new Map<string, Live>();
  private queues = new Map<string, Promise<unknown>>();
  // COMMIT visibility precedes the continuation that publishes its in-memory checkpoint.
  private publications = new Map<string, Promise<void>>();
  private pending = new Map<string, number>();
  private listeners = new Set<(campaignId: string) => void>();
  private npcJobs = new Set<string>();
  private npcTimers = new Set<ReturnType<typeof setTimeout>>();
  private npcCooldown = new Map<string, number>();
  private projections = new Map<string, { hash: string; revision: number }>();
  private timer: ReturnType<typeof setInterval>;
  private unavailableArt = new Set<string>();
  private artCheckedAt = new Map<string, number>();
  private stopping = false;
  private shutdownCallbacks = new Set<() => void>();
  onShutdown(fn: () => void) {
    this.shutdownCallbacks.add(fn);
  }
  constructor(
    @Inject(Db) private db: Db,
    @Inject(Auth) private auth: Auth,
    @Inject(PlayableService) private playable: PlayableService,
    @Inject(NpcAiService) private ai: NpcAiService,
    @Inject(AssetReuseService) private art: AssetReuseService,
    @Optional() @Inject(ImageGenerationService) images?: ImageGenerationService,
  ) {
    this.art.attachRuntimeStateReader((id) => this.live.get(id)?.state);
    images?.attachRuntimeStateReader((id) => {
      const cached = this.live.get(id);
      return cached ? { state: cached.state, dbRevision: cached.dbRevision } : undefined;
    });
    this.timer = setInterval(() => {
      for (const id of this.live.keys()) {
        if ((this.pending.get(id) ?? 0) > 0) continue;
        void this.serial(id, () => this.advance(id)).catch(() => {
          /* Database failure freezes durable mutation; next tick retries. */
        });
      }
    }, 50);
    this.timer.unref();
  }
  subscribe(fn: (id: string) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private notify(id: string) {
    for (const fn of this.listeners) fn(id);
  }
  private async serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    if ((this.pending.get(id) ?? 0) >= 64) fail(429, 'RATE_LIMITED', 'RATE_LIMITED');
    this.pending.set(id, (this.pending.get(id) ?? 0) + 1);
    const previous = this.queues.get(id) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(work);
    this.queues.set(id, result);
    try {
      return await result;
    } finally {
      const remaining = (this.pending.get(id) ?? 1) - 1;
      if (remaining > 0) this.pending.set(id, remaining);
      else this.pending.delete(id);
      if (this.queues.get(id) === result) this.queues.delete(id);
    }
  }
  private async load(id: string) {
    const cached = this.live.get(id);
    if (cached) return cached;
    const rows = await this.db.query(
      `SELECT c.*,s.checksum,s.state AS snapshot_state,v.package->'compiled'->>'title' AS game_title,v.source_revision,v.package AS source_package,v.checksum AS source_checksum FROM game_campaigns c JOIN game_snapshots s ON s.campaign_id=c.id LEFT JOIN game_playable_versions v ON v.id=c.source_version_id WHERE c.id=$1 AND c.status='active' AND EXISTS(SELECT 1 FROM users owner WHERE owner.id=c.owner_id AND owner.deleted_at IS NULL) AND ${sourceLiveSql()}`,
      [id],
    );
    const row = rows[0];
    if (!row) fail(404, 'NOT_FOUND', 'NOT_FOUND');
    if (digest(row.snapshot_state) !== row.checksum || digest(row.state) !== row.checksum)
      fail(503, 'RECOVERY_REQUIRED', 'RECOVERY_REQUIRED');
    const state = row.state as GameState;
    if (row.source_version_id && (!state.narrativePremise || !state.narrativeSource)) {
      if (digest(canonical(row.source_package)) !== row.source_checksum)
        fail(503, 'RECOVERY_REQUIRED', 'RECOVERY_REQUIRED');
      const published = (
        await this.db.query(
          'SELECT av.snapshot FROM game_playable_approvals ap JOIN adventure_versions av ON av.id=ap.adventure_version_id WHERE ap.playable_version_id=$1',
          [row.source_version_id],
        )
      )[0]?.snapshot;
      state.narrativeSource = { versionId: row.source_version_id, checksum: row.source_checksum };
      state.narrativePremise ??= row.source_package.compiled?.narrativePremise ?? {
        title: String(row.source_package.source?.title ?? row.game_title ?? ''),
        summary: String(published?.synopsis ?? ''),
        world: String(row.source_package.source?.content?.world ?? ''),
        genre: String(published?.genre ?? ''),
      };
    }

    // An input from a previous process can never resume after recovery.
    for (const entity of Object.values(state.entities))
      if (entity.kind === 'player' || entity.kind === 'npc') {
        entity.path = [];
        entity.movementGeneration = (entity.movementGeneration ?? 0) + 1;
        const brain = state.npcBrains?.[entity.id];
        if (entity.kind === 'npc' && brain && !entity.encounterId) {
          brain.waitingForPath = false;
          brain.movementGeneration = entity.movementGeneration;
        }
      }
    const pendingJobs = await this.db.query(
      "SELECT id,due_at,deadline_at FROM game_npc_jobs WHERE campaign_id=$1 AND status='queued'",
      [id],
    );
    const savedClock = row.runtime_clock as RuntimeClock;
    const clock: RuntimeClock = savedClock?.capturedAtMs
      ? savedClock
      : {
          paused: true,
          capturedAtMs: new Date(row.updated_at).getTime(),
          rounds: Object.fromEntries(
            Object.values(state.encounters)
              .filter((e) => e.phase === 'planning')
              .map((e) => [e.id, Math.max(0, e.deadlineMs - new Date(row.updated_at).getTime())]),
          ),
          jobs: Object.fromEntries(
            pendingJobs.map((job) => [
              String(job.id),
              {
                dueMs: Math.max(
                  0,
                  new Date(job.due_at).getTime() - new Date(row.updated_at).getTime(),
                ),
                deadlineMs: Math.max(
                  0,
                  new Date(job.deadline_at).getTime() - new Date(row.updated_at).getTime(),
                ),
              },
            ]),
          ),
        };
    const live: Live = {
      state,
      paused: true,
      clock: { ...clock, paused: true },
      presence: new Map(),
      dbRevision: Number(row.revision),
      eventSeq: Number(row.event_seq),
      dirty: true,
      lastCheckpoint: Date.now(),
      lastAccess: Date.now(),
      epoch: randomInt(1, 2147483647),
      actorEpochs: {},
      npcPending: pendingJobs.length > 0,
      aiPending: await this.ai.pending(id),
      deferredNpcIds: [],
      lastRetentionTick: -100,
      decisionsPending: Boolean(
        (
          await this.db.query(
            "SELECT 1 FROM game_npc_decision_requests WHERE campaign_id=$1 AND status='queued' LIMIT 1",
            [id],
          )
        ).length,
      ),
      campaign: {
        title: row.game_title ?? null,
        playableVersionId: row.source_version_id ?? null,
        sourceRevision: row.source_revision ?? null,
      },
    };
    this.live.set(id, live);
    return live;
  }
  async access(req: Request, id: string) {
    z.uuid().parse(id);
    const user = await this.auth.require(req);
    const readAccess = () =>
      this.db.query(
        `SELECT m.actor_id,c.owner_id,c.revision FROM game_members m JOIN game_campaigns c ON c.id=m.campaign_id WHERE m.campaign_id=$1 AND m.user_id=$2 AND m.status='accepted' AND c.status='active' AND EXISTS(SELECT 1 FROM users owner WHERE owner.id=c.owner_id AND owner.deleted_at IS NULL) AND ${sourceAccessSql('$2')}`,
        [id, user.id],
      );
    let rows = await readAccess();
    let cached = this.live.get(id);
    while (rows[0] && cached && Number(rows[0].revision) > cached.dbRevision) {
      const publication = this.publications.get(id);
      if (!publication) break;
      // Do not await the writer queue: callers may already be inside that writer.
      // Only a locally committing checkpoint has this short publication barrier.
      await publication;
      await this.auth.require(req);
      rows = await readAccess();
      cached = this.live.get(id);
    }
    if (!rows[0]) {
      const stillActive = await this.db.query(
        `SELECT c.id FROM game_campaigns c WHERE c.id=$1 AND c.status='active' AND ${sourceLiveSql()}`,
        [id],
      );
      if (!stillActive.length) this.live.delete(id);
      fail(403, 'FORBIDDEN', 'FORBIDDEN');
    }
    // Account erasure and administrative changes may commit outside this process's writer.
    // Never project a cached pre-erasure checkpoint after observing a newer durable revision.
    cached = this.live.get(id);
    if (cached && Number(rows[0].revision) > cached.dbRevision) this.live.delete(id);
    return { user, actorId: String(rows[0].actor_id), ownerId: String(rows[0].owner_id) };
  }
  /** Out-of-character party communication is never copied into NPC state or provider contexts. */
  async chat(req: Request, id: string, body?: unknown) {
    const a = await this.access(req, id);
    if (body !== undefined) {
      const input = z
        .object({ operationId: z.uuid(), text: z.string().trim().min(1).max(1000) })
        .strict()
        .parse(body);
      await this.db.tx(async (c) => {
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `party-chat:${id}:${a.user.id}`,
        ]);
        const allowed = await c.query(
          `SELECT c.id FROM game_campaigns c JOIN game_members m ON m.campaign_id=c.id WHERE c.id=$1 AND m.user_id=$2 AND m.status='accepted' AND c.status='active' AND ${sourceAccessSql('$2')}`,
          [id, a.user.id],
        );
        if (!allowed.rowCount) fail(403, 'FORBIDDEN', 'FORBIDDEN');
        const previous = (
          await c.query(
            'SELECT text FROM game_party_chat WHERE campaign_id=$1 AND sender_user_id=$2 AND operation_id=$3',
            [id, a.user.id, input.operationId],
          )
        ).rows[0];
        if (previous) {
          if (previous.text !== input.text)
            fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
          return;
        }
        const count = Number(
          (
            await c.query(
              "SELECT count(*) FROM game_party_chat WHERE campaign_id=$1 AND sender_user_id=$2 AND created_at>now()-interval '1 minute'",
              [id, a.user.id],
            )
          ).rows[0].count,
        );
        if (count >= 30) fail(429, 'RATE_LIMITED', 'RATE_LIMITED');
        await c.query(
          'INSERT INTO game_party_chat(id,campaign_id,sender_user_id,sender_actor_id,operation_id,text) VALUES($1,$2,$3,$4,$5,$6)',
          [randomUUID(), id, a.user.id, a.actorId, input.operationId, input.text],
        );
      });
    }
    const rows = await this.db.query(
      'SELECT id,sender_actor_id AS "senderActorId",text,created_at AS "createdAt" FROM game_party_chat WHERE campaign_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100',
      [id],
    );
    return { channel: 'out-of-character', messages: rows.reverse() };
  }
  private intentContext(state: GameState, actorId: string, text: string, proposalId: string) {
    const p = projectState(state, actorId),
      actor = state.entities[actorId];
    const context = {
      intentProposalId: proposalId,
      actorId,
      text,
      mapId: actor.mapId,
      actorRevision: actor.revision,
      visibleEntities: p.entities.map((e) => ({
        id: e.id,
        kind: e.kind,
        label: e.label,
        mapId: e.mapId,
        x: e.x,
        y: e.y,
        revision: e.revision,
      })),
      ownInventory: (actor.inventory ?? []).map((id) => ({
        id,
        label: state.entities[id]?.label,
        revision: state.entities[id]?.revision,
      })),
      allowedActions: ['open', 'close', 'inspect', 'pick_up', 'knock', 'wait', 'give'],
    };
    return packNpcContext(context, this.ai.contextBudgetBytes());
  }
  private intentDto(row: Record<string, unknown>, tick: number) {
    const p = row.proposal as ReturnType<typeof proposePlayerTextIntent>;
    return {
      id: row.id,
      status: row.status,
      action: p?.action,
      code: row.result_code ?? undefined,
      cost: 0,
      generationCost:
        row.generation_credits == null
          ? row.decision_status === 'fallback'
            ? 0
            : null
          : row.job_status === 'committed'
            ? Number(row.generation_credits)
            : ['stale', 'cancelled', 'failed'].includes(String(row.job_status))
              ? 0
              : null,
      funding: row.sponsored
        ? 'session-budget'
        : row.generation_credits == null
          ? row.decision_status === 'fallback'
            ? 'free'
            : null
          : Number(row.generation_credits) === 0
            ? 'free'
            : 'personal',
      expiresAt: new Date(
        Date.now() + Math.max(0, Number(row.valid_until_tick) - tick) * 50,
      ).toISOString(),
    };
  }
  private async reconcileIntents(id: string, tick: number) {
    await this.db.tx(async (c) => {
      await c.query(
        `UPDATE game_npc_decision_requests r SET status='cancelled',context='{}',result_code='INTENT_EXPIRED' FROM game_player_intent_proposals p WHERE p.decision_request_id=r.id AND p.campaign_id=$1 AND p.status IN ('pending','proposed') AND p.valid_until_tick<$2 AND r.status IN ('queued','scheduled')`,
        [id, tick],
      );
      await c.query(
        `UPDATE game_player_intent_proposals p SET status='cancelled',proposal=NULL,result_code=CASE WHEN p.valid_until_tick<$2 THEN 'INTENT_EXPIRED' ELSE 'DECISION_UNAVAILABLE' END FROM game_npc_decision_requests r LEFT JOIN npc_ai_jobs j ON j.id=r.job_id WHERE p.decision_request_id=r.id AND p.campaign_id=$1 AND p.status IN ('pending','proposed') AND (p.valid_until_tick<$2 OR r.status IN ('cancelled','failed') OR (p.status='pending' AND j.status IN ('stale','cancelled','failed')))`,
        [id, tick],
      );
    });
  }
  async intents(req: Request, id: string, body?: unknown) {
    return this.serial(id, async () => {
      const a = await this.access(req, id),
        live = await this.load(id);
      await this.touch(id, live, a.actorId);
      await this.reconcileIntents(id, live.state.tick);
      if (body !== undefined) {
        const input = z
            .object({ operationId: z.uuid(), text: z.string().trim().min(1).max(1000) })
            .strict()
            .parse(body),
          hash = digest(input);
        const prior = (
          await this.db.query(
            'SELECT * FROM game_player_intent_proposals WHERE campaign_id=$1 AND requester_user_id=$2 AND operation_id=$3',
            [id, a.user.id, input.operationId],
          )
        )[0];
        if (prior) {
          if (prior.request_hash !== hash)
            fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
          return this.intentDto(prior, live.state.tick);
        }
        const count = Number(
          (
            await this.db.query(
              "SELECT count(*) FROM game_player_intent_proposals WHERE campaign_id=$1 AND requester_user_id=$2 AND status='pending'",
              [id, a.user.id],
            )
          )[0].count,
        );
        if (count >= 4) fail(429, 'RATE_LIMITED', 'RATE_LIMITED');
        const proposalId = randomUUID(),
          requestId = randomUUID(),
          context = this.intentContext(live.state, a.actorId, input.text, proposalId),
          parsed = proposePlayerTextIntent(live.state, a.actorId, input.text);
        const decision: NpcDecisionRequest = {
          id: requestId,
          npcId: a.actorId,
          purpose: 'intent',
          causeKey: `intent:${a.actorId}:${input.operationId}`,
          requesterUserId: a.user.id,
          recipientActorId: a.actorId,
          context: {
            ...context,
            mockProposal: parsed
              ? { kind: 'action', action: parsed.action }
              : { kind: 'clarify', messageCode: 'AMBIGUOUS' },
          },
        };
        const until = live.state.tick + 1200;
        await this.persist(
          id,
          live,
          live.state,
          'player.intent.requested',
          undefined,
          async (c) => {
            await insertNpcRequest(c, id, decision);
            await c.query(
              'INSERT INTO game_player_intent_proposals(id,campaign_id,actor_id,requester_user_id,operation_id,request_hash,text,decision_request_id,valid_until_tick) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
              [
                proposalId,
                id,
                a.actorId,
                a.user.id,
                input.operationId,
                hash,
                input.text,
                requestId,
                until,
              ],
            );
          },
        );
        live.decisionsPending = true;
        return this.intentDto(
          { id: proposalId, status: 'pending', valid_until_tick: until },
          live.state.tick,
        );
      }
      const rows = await this.db.query(
        `SELECT p.*,r.status AS decision_status,j.credits AS generation_credits,j.status AS job_status,(j.sponsor_id IS NOT NULL) AS sponsored FROM game_player_intent_proposals p LEFT JOIN game_npc_decision_requests r ON r.id=p.decision_request_id LEFT JOIN npc_ai_jobs j ON j.id=r.job_id WHERE p.campaign_id=$1 AND p.requester_user_id=$2 ORDER BY p.created_at DESC LIMIT 20`,
        [id, a.user.id],
      );
      return { proposals: rows.map((r) => this.intentDto(r, live.state.tick)) };
    });
  }
  async confirmIntent(req: Request, id: string, proposalId: string, body: unknown) {
    const b = z.object({ operationId: z.uuid() }).strict().parse(body);
    z.uuid().parse(proposalId);
    return this.command(req, id, {
      protocolVersion: 1,
      operationId: b.operationId,
      type: 'intent.confirm',
      proposalId,
    });
  }
  async sponsors(req: Request, id: string, body?: unknown, sponsorId?: string) {
    const a = await this.access(req, id);
    if (sponsorId) {
      z.uuid().parse(sponsorId);
      await this.ai.revokeSponsor(id, a.user.id, sponsorId);
    } else if (body !== undefined)
      await this.ai.grantSponsor(
        id,
        a.user.id,
        body as Parameters<NpcAiService['grantSponsor']>[2],
      );
    return {
      sponsors: await this.ai.sponsors(id, a.user.id),
      configuration: this.ai.configuration(),
    };
  }
  /** Player-facing metadata only; decision contexts remain server-private. */
  private narrativeDto(row: Record<string, unknown>) {
    const terminal =
      ['cancelled', 'failed', 'stale'].includes(String(row.job_status)) ||
      ['cancelled', 'failed'].includes(String(row.request_status));
    const status = row.status === 'pending' && terminal ? 'failed' : row.status;
    const result = row.result as Record<string, unknown> | null;
    return {
      id: row.id,
      operationId: row.operation_id,
      actorId: row.actor_id,
      status,
      text: row.input_text,
      createdAt: (row.created_at as Date).toISOString(),
      ...(status === 'committed' && result ? result : {}),
      ...(row.result_code || terminal ? { code: row.result_code ?? 'DECISION_UNAVAILABLE' } : {}),
      ...(row.job_status ? { jobStatus: row.job_status } : {}),
    };
  }
  async narrative(req: Request, id: string, body?: unknown, quote = false) {
    return this.serial(id, async () => {
      const a = await this.access(req, id),
        live = await this.load(id);
      const canonRevision = live.state.narrativeCanon?.revision ?? 0;
      await this.db.query(
        `UPDATE game_narrative_turns t SET status='failed',result_code='DECISION_UNAVAILABLE' FROM game_npc_decision_requests r LEFT JOIN npc_ai_jobs j ON j.id=r.job_id WHERE t.id=r.id AND t.campaign_id=$1 AND t.status='pending' AND (r.status IN ('cancelled','failed') OR j.status IN ('stale','cancelled','failed'))`,
        [id],
      );

      if (body === undefined) {
        const rows = await this.db.query(
          `SELECT t.*,j.status AS job_status,r.status AS request_status FROM game_narrative_turns t JOIN game_npc_decision_requests r ON r.id=t.id LEFT JOIN npc_ai_jobs j ON j.id=r.job_id WHERE t.campaign_id=$1 AND (t.status='committed' OR t.requester_user_id=$2) ORDER BY t.created_at DESC LIMIT 64`,
          [id, a.user.id],
        );
        return {
          canonRevision,
          configuration: this.ai.configuration(),
          canSubmit: live.state.rulesetVersion === 'hybrid-v3',
          unavailableReason:
            live.state.rulesetVersion === 'hybrid-v3' ? null : 'NARRATIVE_RULESET_REQUIRED',
          turns: rows.reverse().map((r) => this.narrativeDto(r)),
        };
      }
      if (live.state.rulesetVersion !== 'hybrid-v3')
        fail(409, 'NARRATIVE_RULESET_REQUIRED', 'NARRATIVE_RULESET_REQUIRED');
      const input = z
        .object({
          text: z.string().trim().min(1).max(1000),
          expectedCanonRevision: z.number().int().nonnegative(),
          audience: z.literal('shared').default('shared'),
          operationId: z.uuid().optional(),
          quoteId: z.uuid().optional(),
          sponsorId: z.uuid().optional(),
          consent: z.boolean().optional(),
        })
        .strict()
        .parse(body);
      const requestHash = digest(canonical(input));
      if (!quote && input.operationId) {
        const prior = (
          await this.db.query(
            'SELECT * FROM game_narrative_turns WHERE campaign_id=$1 AND requester_user_id=$2 AND operation_id=$3',
            [id, a.user.id, input.operationId],
          )
        )[0];
        if (prior) {
          if (prior.request_hash !== requestHash)
            fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
          return this.narrativeDto(prior);
        }
      }
      if (input.expectedCanonRevision !== canonRevision) fail(409, 'STALE_CANON', 'STALE_CANON');
      const base = buildNarrativeContext(live.state, a.actorId, input.text);
      const scope = {
        campaignId: id,
        npcId: a.actorId,
        subjectKind: 'player' as const,
        origin: 'user' as const,
        purpose: 'narrative' as const,
        requesterUserId: a.user.id,
      };
      if (quote) return { ...(await this.ai.quote(scope, base, a.user.id)), canonRevision };
      if (!input.operationId || input.consent !== true)
        fail(403, 'CONSENT_REQUIRED', 'CONSENT_REQUIRED');
      const count = (
        await this.db.query(
          "SELECT count(*) FILTER(WHERE status='pending')::int AS pending,count(*)::int AS total FROM game_narrative_turns WHERE campaign_id=$1 AND requester_user_id=$2",
          [id, a.user.id],
        )
      )[0];
      if (count.pending >= 2 || count.total >= 512) fail(429, 'RATE_LIMITED', 'RATE_LIMITED');
      const turnId = randomUUID(),
        context = {
          ...base,
          turnId,
          intent: input.text,
          mockProposal: createMockNarrativeProposal(live.state, a.actorId, input.text, turnId),
        };
      if (Buffer.byteLength(JSON.stringify(context)) > this.ai.contextBudgetBytes())
        fail(413, 'CONTEXT_BUDGET_EXCEEDED', 'CONTEXT_BUDGET_EXCEEDED');
      await this.touch(id, live, a.actorId);
      await this.persist(id, live, live.state, 'narrative.requested', undefined, async (c) => {
        const allowed = await c.query(
          `SELECT c.id FROM game_campaigns c JOIN game_members m ON m.campaign_id=c.id JOIN users u ON u.id=m.user_id WHERE c.id=$1 AND m.user_id=$2 AND m.status='accepted' AND u.deleted_at IS NULL AND ${sourceAccessSql('$2')}`,
          [id, a.user.id],
        );
        if (!allowed.rowCount) fail(403, 'FORBIDDEN', 'FORBIDDEN');
        await insertNpcRequest(c, id, {
          id: turnId,
          npcId: a.actorId,
          purpose: 'narrative',
          causeKey: `narrative:${a.actorId}:${input.operationId}`,
          requesterUserId: a.user.id,
          context,
        });
        await c.query(
          "INSERT INTO game_narrative_turns(id,campaign_id,requester_user_id,actor_id,operation_id,request_hash,expected_canon_revision,input_text,status,quote_id,sponsor_id,consent) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10,true)",
          [
            turnId,
            id,
            a.user.id,
            a.actorId,
            input.operationId,
            requestHash,
            canonRevision,
            input.text,
            input.quoteId ?? null,
            input.sponsorId ?? null,
          ],
        );
      });
      live.decisionsPending = true;
      return this.narrativeDto(
        (await this.db.query('SELECT * FROM game_narrative_turns WHERE id=$1', [turnId]))[0],
      );
    });
  }
  async mediaPreparation(req: Request, id: string, body: unknown) {
    const input = mediaPreparationSchema.parse(body);
    return this.serial(id, async () => {
      const a = await this.access(req, id),
        live = await this.load(id);
      const source = (
        await this.db.query(
          'SELECT c.source_version_id,v.adventure_id,a.owner_id,v.checksum FROM game_campaigns c LEFT JOIN game_playable_versions v ON v.id=c.source_version_id LEFT JOIN adventures a ON a.id=v.adventure_id WHERE c.id=$1',
          [id],
        )
      )[0];
      const prepared = prepareSceneMedia(
        live.state,
        a.actorId,
        source.source_version_id ?? 'observatory-v1',
        input,
      );
      const matches = await this.art.search(a.user.id, {
        kind: prepared.spec.kind,
        style: 'drawn2D',
        camera: prepared.spec.camera,
        tags: [],
        minWidth: 1,
        minHeight: 1,
      });
      return {
        ...prepared,
        canonRevision: live.state.narrativeCanon?.revision ?? 0,
        sourceChecksum: source.checksum ?? null,
        adventureId: source.adventure_id ?? null,
        canGenerate: a.ownerId === a.user.id,
        canAttach: a.ownerId === a.user.id,
        expectedMapId: live.state.entities[a.actorId].mapId,
        slot:
          input.kind === 'background'
            ? `map:${live.state.entities[a.actorId].mapId}:background`
            : `entity:${input.entityId}:portrait`,
        matches,
        providerCalls: 0,
        charge: 0,
      };
    });
  }
  async mediaBinding(req: Request, id: string, body: unknown) {
    const input = mediaPreparationSchema
      .extend({
        operationId: z.uuid(),
        expectedCanonRevision: z.number().int().nonnegative(),
        expectedMapId: z.string().min(1).max(100),
        revisionId: z.uuid(),
      })
      .strict()
      .parse(body);
    return this.serial(id, async () => {
      const a = await this.access(req, id),
        live = await this.load(id);
      if (a.ownerId !== a.user.id) fail(403, 'FORBIDDEN', 'FORBIDDEN');
      const hash = digest({ type: 'art.attach', ...input });
      const prior = (
        await this.db.query(
          'SELECT request_hash,result FROM game_operations WHERE campaign_id=$1 AND actor_id=$2 AND operation_id=$3',
          [id, a.actorId, input.operationId],
        )
      )[0];
      if (prior) {
        if (prior.request_hash !== hash) fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
        await this.refreshArt(id, live, true);
        return { ...prior.result, projection: this.project(live.state, a.actorId) };
      }
      if (
        (live.state.narrativeCanon?.revision ?? 0) !== input.expectedCanonRevision ||
        live.state.entities[a.actorId].mapId !== input.expectedMapId
      )
        fail(409, 'STALE_CANON', 'STALE_CANON');
      // Validate current visibility and subject before considering any private library revision.
      const view = projectState(live.state, a.actorId);
      if (
        input.kind === 'portrait' &&
        !view.entities.some((e) => e.id === input.entityId && e.kind === 'npc')
      )
        fail(404, 'NOT_FOUND', 'NOT_FOUND');
      if (input.kind === 'background' && input.entityId)
        fail(400, 'INVALID_ACTION', 'INVALID_ACTION');
      const slot =
        input.kind === 'background'
          ? `map:${input.expectedMapId}:background`
          : `entity:${input.entityId}:portrait`;
      await this.touch(id, live, a.actorId);
      const response = {
        status: 'applied',
        projection: this.project(live.state, a.actorId),
        slot,
        revisionId: input.revisionId,
        charge: 0,
      };
      await this.persist(
        id,
        live,
        live.state,
        'art.attached',
        {
          actorId: a.actorId,
          command: { operationId: input.operationId },
          hash,
          response,
        },
        undefined,
        async (c, state) => {
          const binding = await this.art.pinCampaignArtTx(
            c,
            a.user.id,
            id,
            state,
            slot,
            input.revisionId,
          );
          const next = structuredClone(state);
          next.artBindings = [...(next.artBindings ?? []).filter((b) => b.slot !== slot), binding];
          if (next.artBindings.length > 128) fail(409, 'ART_LIMIT', 'ART_LIMIT');
          next.revision++;
          response.projection = this.project(next, a.actorId);
          return next;
        },
      );
      return response;
    });
  }
  async aiStatus(req: Request, id: string) {
    const a = await this.access(req, id);
    return {
      configuration: this.ai.configuration(),
      jobs: await this.ai.status(id, a.user.id),
      wallet: await this.ai.wallet(a.user.id),
    };
  }
  async aiDecision(req: Request, id: string, body: unknown, quote = false) {
    const input = z
      .object({
        npcId: z
          .string()
          .regex(/^[\w-]+$/)
          .max(100),
        purpose: z.enum(['plan', 'summary', 'speech']).default('plan'),
        channel: z.enum(['say', 'whisper']).default('say'),
        topicId: z
          .string()
          .regex(/^[\w-]+$/)
          .max(100)
          .optional(),
        operationId: z.uuid().optional(),
        quoteId: z.uuid().optional(),
        consent: z.boolean().optional(),
      })
      .strict()
      .parse(body);
    return this.serial(id, async () => {
      const a = await this.access(req, id),
        live = await this.load(id);
      if (live.state.rulesetVersion !== 'hybrid-v3' || !live.state.npcBrains?.[input.npcId]?.living)
        fail(404, 'NOT_FOUND', 'NOT_FOUND');
      const scope = {
        campaignId: id,
        npcId: input.npcId,
        origin: 'user' as const,
        purpose: input.purpose,
        requesterUserId: a.user.id,
      };
      const requestKey =
        input.purpose === 'speech'
          ? `${input.channel}:${a.actorId}:${input.topicId ?? ''}`
          : input.purpose;
      if (!quote && input.operationId) {
        const previous = await this.ai.replay(
          scope,
          input.operationId,
          input.quoteId,
          input.consent,
          requestKey,
        );
        if (previous) return previous;
      }
      // A player cannot schedule work for an NPC outside their current visible scene.
      if (!projectState(live.state, a.actorId).entities.some((e) => e.id === input.npcId))
        fail(404, 'NOT_FOUND', 'NOT_FOUND');
      const base =
        input.purpose === 'speech'
          ? this.speechContext(
              live.state,
              input.npcId,
              a.actorId,
              input.channel,
              undefined,
              input.topicId,
            )
          : await this.decisionContext(id, live.state, input.npcId, input.purpose);
      const context = {
        ...base,
        mockProposal:
          input.purpose === 'speech'
            ? createMockNpcPublicResponse(base as ReturnType<typeof buildNpcPublicSpeechContext>)
            : input.purpose === 'summary'
              ? createNpcMemorySummary(live.state, input.npcId)
              : createMockNpcPlan(live.state, input.npcId),
      };
      if (context.budgetExceeded) fail(413, 'CONTEXT_BUDGET_EXCEEDED', 'CONTEXT_BUDGET_EXCEEDED');
      if (quote) return this.ai.quote(scope, context, a.user.id);
      if (!input.operationId) fail(400, 'INVALID_ACTION', 'INVALID_ACTION');
      const result = await this.ai.queue({
        scope,
        context,
        operationId: input.operationId!,
        requesterUserId: a.user.id,
        quoteId: input.quoteId,
        consent: input.consent,
        requestKey,
      });
      live.aiPending = true;
      this.dispatchAi(id);
      return result;
    });
  }
  private async decisionContext(id: string, state: GameState, npcId: string, purpose: string) {
    const base = buildNpcDecisionContext(state, npcId);
    if (purpose !== 'plan') return packNpcContext(base, this.ai.contextBudgetBytes());
    const archivedEpisodes = await recallNpcEpisodes(this.db, id, state, npcId);
    return packNpcContext({ ...base, archivedEpisodes }, this.ai.contextBudgetBytes());
  }
  private speechContext(
    state: GameState,
    npcId: string,
    recipientId: string,
    channel: 'say' | 'whisper',
    selected?: string[],
    topicId?: string,
    replyToObservationId?: string,
  ) {
    const npc = state.entities[npcId],
      recipient = state.entities[recipientId];
    if (
      !npc ||
      !recipient ||
      npc.mapId !== recipient.mapId ||
      Math.abs(npc.x - recipient.x) + Math.abs(npc.y - recipient.y) > 1 ||
      npc.encounterId ||
      recipient.encounterId
    )
      fail(409, 'OUT_OF_RANGE', 'OUT_OF_RANGE');
    const audience =
      channel === 'whisper'
        ? [recipientId, npcId]
        : Object.values(state.entities)
            .filter((e) => ['npc', 'player'].includes(e.kind) && canNpcHear(state, e, npc))
            .map((e) => e.id)
            .sort();
    const namedTopic = topicId ? resolveNpcFactTopic(state, npcId, topicId) : [];
    if (
      topicId &&
      !namedTopic.length &&
      !projectState(state, recipientId).entities.some((e) => e.id === topicId)
    )
      fail(404, 'NOT_FOUND', 'NOT_FOUND');
    const memory = state.npcBrains![npcId].living!;
    if (
      replyToObservationId &&
      !npcReplyObservation(state, recipientId, npcId, replyToObservationId)
    )
      fail(409, 'STALE_STATE', 'STALE_STATE');
    // Ask permissions derive from an authenticated visible topic, never proposed secret IDs.
    const requestedFactIds = namedTopic.length
      ? namedTopic
      : topicId
        ? memory.observations
            .filter(
              (o) =>
                o.targetId === topicId &&
                o.kind === 'known_entity' &&
                o.revealCondition === 'asked',
            )
            .map((o) => o.id)
        : [];
    const observations =
      selected ??
      [
        ...new Set([
          ...(replyToObservationId ? [replyToObservationId] : []),
          ...requestedFactIds,
          ...memory.observations.slice(-16).map((o) => o.id),
        ]),
      ].slice(0, 16);
    const publicContext = buildNpcPublicSpeechContext(
      state,
      npcId,
      audience,
      observations,
      requestedFactIds,
    );
    const currentUtterance = replyToObservationId
      ? publicContext.claims.find((c) => c.observationId === replyToObservationId)
      : undefined;
    if (replyToObservationId && !currentUtterance) fail(409, 'STALE_STATE', 'STALE_STATE');
    const observationIds = publicContext.claims.map((c) => c.observationId);
    const safe = {
      ...publicContext,
      ...(replyToObservationId ? { replyToObservationId, currentUtterance } : {}),
      recipientId,
      channel,
      observationIds,
      topicId,
      requestedFactIds,
      speechHash: npcContextFingerprint(publicContext),
    };
    return packNpcContext(safe, this.ai.contextBudgetBytes());
  }
  private dispatchAi(id: string) {
    // Network/provider work must never occupy the campaign writer or a DB transaction.
    void this.ai
      .runNext(id, async () => {
        const live = this.live.get(id);
        if (
          !live ||
          live.paused ||
          ![...live.presence.values()].some((t) => Date.now() - t <= 5000)
        )
          return false;
        return Boolean(
          (
            await this.db.query(
              `SELECT c.id FROM game_campaigns c WHERE c.id=$1 AND c.status='active' AND ${sourceLiveSql()}`,
              [id],
            )
          ).length,
        );
      })
      .catch(() => {
        /* Durable jobs expose failure/reconciliation through safe status DTO. */
      });
  }
  private async evaluateDecision(
    id: string,
    state: GameState,
    job: Pick<ReadyDecision, 'id' | 'npcId' | 'purpose' | 'context' | 'contextHash' | 'proposal'>,
  ) {
    let next = state,
      accepted = false;
    let intentOutcome:
      | {
          id: string;
          status: 'proposed' | 'clarification';
          proposal: ReturnType<typeof proposePlayerTextIntent>;
          code?: string;
        }
      | undefined;
    let narrativeOutcome:
      { id: string; accepted: boolean; result: Record<string, unknown> | null } | undefined;
    const memory = state.npcBrains?.[job.npcId]?.living;
    if (job.purpose === 'narrative') {
      const metadata = z
        .object({ turnId: z.uuid(), intent: z.string().min(1).max(1000) })
        .passthrough()
        .safeParse(job.context);
      if (metadata.success) {
        const proposal = job.proposal as { turnId?: unknown } | null;
        if (proposal?.turnId === metadata.data.turnId) {
          const applied = applyNarrativeProposal(
            state,
            job.npcId,
            job.proposal,
            metadata.data.intent,
          );
          if (!applied.error) {
            next = recordNpcEvents(
              state,
              applied.state,
              applied.events,
              `narrative-${metadata.data.turnId}`,
            ).state;
            accepted = true;
          }
        }
        const turn = accepted
          ? next.narrativeCanon?.turns.find((t) => t.id === metadata.data.turnId)
          : undefined;
        narrativeOutcome = {
          id: metadata.data.turnId,
          accepted,
          result: turn
            ? {
                narration: turn.narration,
                canonRevision: next.narrativeCanon!.revision,
                ...(turn.sceneId ? { sceneId: turn.sceneId } : {}),
                ...(turn.npcId ? { npcId: turn.npcId } : {}),
                tick: turn.tick,
              }
            : null,
        };
      }
    } else if (job.purpose === 'intent') {
      const context = z
        .object({
          intentProposalId: z.uuid(),
          actorId: z.string(),
          text: z.string().max(1000),
          mapId: z.string(),
          actorRevision: z.number(),
          visibleEntities: z.array(
            z.object({ id: z.string(), revision: z.number() }).passthrough(),
          ),
        })
        .passthrough()
        .safeParse(job.context);
      const output = z
        .discriminatedUnion('kind', [
          z.object({ kind: z.literal('action'), action: gameActionSchema }).strict(),
          z
            .object({
              kind: z.literal('clarify'),
              messageCode: z.enum(['AMBIGUOUS', 'UNSUPPORTED']),
            })
            .strict(),
        ])
        .safeParse(job.proposal);
      if (
        context.success &&
        output.success &&
        context.data.actorId === job.npcId &&
        state.entities[job.npcId]?.kind === 'player'
      ) {
        let proposal: ReturnType<typeof proposePlayerTextIntent> = null;
        if (
          output.data.kind === 'action' &&
          state.entities[job.npcId].revision === context.data.actorRevision &&
          state.entities[job.npcId].mapId === context.data.mapId
        ) {
          const targetId = output.data.action.targetId;
          const target = targetId
            ? context.data.visibleEntities.find((e) => e.id === targetId)
            : undefined;
          if (!targetId || (target && state.entities[targetId]?.revision === target.revision))
            proposal = proposePlayerActionIntent(
              state,
              job.npcId,
              context.data.text,
              output.data.action,
            );
        }
        intentOutcome = {
          id: context.data.intentProposalId,
          status: proposal ? 'proposed' : 'clarification',
          proposal,
          code: proposal
            ? undefined
            : output.data.kind === 'clarify'
              ? output.data.messageCode
              : 'STALE_STATE',
        };
        accepted = true;
      }
    } else if (memory && job.purpose === 'speech') {
      const request = z
        .object({
          recipientId: z.string(),
          channel: z.enum(['say', 'whisper']),
          observationIds: z.array(z.string()).max(16),
          topicId: z.string().optional(),
          replyToObservationId: z.string().max(200).optional(),
        })
        .passthrough()
        .safeParse(job.context);
      const proposal = z
        .union([
          z.object({ text: z.string().trim().min(1).max(1000) }).strict(),
          z.object({ code: z.literal('acknowledged') }).strict(),
        ])
        .safeParse(job.proposal);
      if (request.success && proposal.success) {
        let context: ReturnType<GameService['speechContext']> | undefined;
        try {
          context = this.speechContext(
            state,
            job.npcId,
            request.data.recipientId,
            request.data.channel,
            request.data.observationIds,
            request.data.topicId,
            request.data.replyToObservationId,
          );
        } catch {
          /* No longer nearby/in same phase: stale, never broadcast. */
        }
        if (context?.contextHash === job.contextHash) {
          const result = commitNpcPublicUtterance(state, job.npcId, {
            ...proposal.data,
            channel: context.channel,
            recipientId: context.recipientId,
            observationIds: context.observationIds,
            requestedFactIds: context.requestedFactIds,
            contextHash: context.speechHash,
          });
          if (!result.error) {
            next = result.state;
            accepted = true;
          }
        }
      }
    } else if (
      memory &&
      (await this.decisionContext(id, state, job.npcId, job.purpose)).contextHash ===
        job.contextHash
    ) {
      if (job.purpose === 'plan') {
        const result = acceptNpcPlan(state, job.npcId, job.proposal);
        if (!result.error) {
          next = recordNpcEvents(state, result.state, result.events, `ai-${job.id}`).state;
          accepted = true;
        }
      } else if (job.purpose === 'summary') {
        const selection = z
          .object({ selectedObservationIds: z.array(z.string()).max(16) })
          .strict()
          .safeParse(job.proposal);
        let proposal = job.proposal;
        if (selection.success) {
          const available = new Set(
            (job.context.observations as { id: string }[] | undefined)?.map((o) => o.id),
          );
          if (selection.data.selectedObservationIds.every((id) => available.has(id)))
            try {
              proposal = createNpcMemorySummarySelection(
                state,
                job.npcId,
                selection.data.selectedObservationIds,
              );
            } catch {
              proposal = null;
            }
          else proposal = null;
        }
        const result = acceptNpcMemorySummary(state, job.npcId, proposal);
        if (!result.error) {
          next = result.state;
          accepted = true;
        }
      }
    }
    if (!accepted)
      recordNpcMetric(job.purpose === 'summary' ? 'summaryRejected' : 'knowledgeRejected');
    return { next, accepted, intentOutcome, narrativeOutcome };
  }
  private async saveNarrativeOutcome(
    c: import('pg').PoolClient,
    campaignId: string,
    state: GameState,
    outcome: { id: string; accepted: boolean; result: Record<string, unknown> | null } | undefined,
  ) {
    if (!outcome) return;
    const changed = await c.query(
      "UPDATE game_narrative_turns SET status=$2,result=$3,result_code=$4,committed_at=CASE WHEN $2='committed' THEN now() ELSE NULL END WHERE id=$1 AND campaign_id=$5 AND status='pending' RETURNING id",
      [
        outcome.id,
        outcome.accepted ? 'committed' : 'stale',
        JSON.stringify(outcome.result),
        outcome.accepted ? null : 'STALE_OR_INVALID_PROPOSAL',
        campaignId,
      ],
    );
    if (!changed.rowCount) fail(409, 'STALE_STATE', 'STALE_STATE');
    await c.query(
      "UPDATE game_npc_decision_requests SET status=$2,result_code=$3 WHERE id=$1 AND status='scheduled'",
      [
        outcome.id,
        outcome.accepted ? 'committed' : 'failed',
        outcome.accepted ? null : 'STALE_OR_INVALID_PROPOSAL',
      ],
    );
    const sceneId = outcome.result?.sceneId;
    if (outcome.accepted && typeof sceneId === 'string' && state.maps[sceneId]) {
      const source = (
        await c.query('SELECT source_version_id FROM game_campaigns WHERE id=$1', [campaignId])
      ).rows[0];
      const map = state.maps[sceneId],
        specification = {
          schemaVersion: 1,
          sourceVersionId: source.source_version_id,
          canonRevision: state.narrativeCanon?.revision ?? 0,
          mapId: sceneId,
          map: { width: map.width, height: map.height, blocked: map.blocked },
          layers: Object.values(state.entities)
            .filter((e) => e.mapId === sceneId)
            .map((e) => ({ id: e.id, kind: e.kind, x: e.x, y: e.y })),
          backgroundPolicy: 'floor-only; all interactive geometry and actors are engine overlays',
          automaticDispatch: false,
        };
      await c.query(
        'INSERT INTO game_narrative_media(turn_id,campaign_id,map_id,canon_revision,specification) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [
          outcome.id,
          campaignId,
          sceneId,
          state.narrativeCanon?.revision ?? 0,
          JSON.stringify({ ...specification, groundingHash: digest(canonical(specification)) }),
        ],
      );
    }
  }
  private async saveIntentOutcome(
    c: import('pg').PoolClient,
    outcome: Awaited<ReturnType<GameService['evaluateDecision']>>['intentOutcome'],
  ) {
    if (!outcome) return;
    const updated = await c.query(
      "UPDATE game_player_intent_proposals SET status=$2,proposal=$3,result_code=$4 WHERE id=$1 AND status='pending' RETURNING id",
      [outcome.id, outcome.status, JSON.stringify(outcome.proposal), outcome.code ?? null],
    );
    if (!updated.rowCount) fail(409, 'STALE_STATE', 'STALE_STATE');
  }
  private async scheduleAutonomousRequests(id: string, live: Live) {
    if (
      !Object.values(live.state.npcBrains ?? {}).some((b) =>
        b.living?.causes.some((c) => c.priority >= 2 && c.notBeforeTick <= live.state.tick),
      )
    )
      return;
    const pending = Number(
      (
        await this.db.query(
          "SELECT count(*) FROM game_npc_decision_requests WHERE campaign_id=$1 AND status='queued'",
          [id],
        )
      )[0].count,
    );
    if (pending >= 16) return;
    const requests: NpcDecisionRequest[] = [];
    for (const [npcId, b] of Object.entries(live.state.npcBrains ?? {})) {
      const npc = live.state.entities[npcId];
      if (!b.living || npc.encounterId || b.cursor < b.plan.length || npc.path?.length) continue;
      const cause = b.living.causes
        .filter(
          (c) =>
            c.priority >= 2 &&
            c.notBeforeTick <= live.state.tick &&
            ['item_taken', 'item_missing', 'claim', 'noise'].includes(
              b.living!.observations.find((o) => o.id === c.observationId)?.kind ?? '',
            ),
        )
        .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))[0];
      if (!cause) continue;
      recordNpcMetric('causeSamples');
      recordNpcMetric('causeDelayTicks', Math.max(0, live.state.tick - cause.notBeforeTick));
      const exists = await this.db.query(
        'SELECT 1 FROM game_npc_decision_requests WHERE campaign_id=$1 AND npc_id=$2 AND cause_key=$3',
        [id, npcId, `cause:${cause.id}`],
      );
      if (exists.length) continue;
      const context = await this.decisionContext(id, live.state, npcId, 'plan');
      requests.push({
        id: randomUUID(),
        npcId,
        purpose: 'plan',
        causeKey: `cause:${cause.id}`,
        context: { ...context, mockProposal: createMockNpcPlan(live.state, npcId) },
      });
      if (requests.length >= Math.min(2, 16 - pending)) break;
    }
    if (requests.length) {
      await this.persist(id, live, live.state, 'npc.decision.requested', undefined, async (c) => {
        for (const r of requests) await insertNpcRequest(c, id, r);
      });
      live.decisionsPending = true;
      live.deferredNpcIds = [...new Set([...live.deferredNpcIds, ...requests.map((r) => r.npcId)])];
    }
  }
  private async processDecisionRequests(id: string, live: Live) {
    await this.reconcileIntents(id, live.state.tick);
    const requests = await this.db.query(
      "SELECT * FROM game_npc_decision_requests WHERE campaign_id=$1 AND status='queued' ORDER BY created_at,id LIMIT 8",
      [id],
    );
    for (const r of requests) {
      const allowed = r.requester_user_id
        ? await this.db.query(
            `SELECT c.id FROM game_campaigns c JOIN game_members m ON m.campaign_id=c.id JOIN users u ON u.id=m.user_id WHERE c.id=$1 AND m.user_id=$2 AND m.status='accepted' AND u.deleted_at IS NULL AND ${sourceAccessSql('$2')}`,
            [id, r.requester_user_id],
          )
        : [{ id }];
      if (
        !allowed.length ||
        (r.purpose === 'intent' || r.purpose === 'narrative'
          ? live.state.entities[r.npc_id]?.kind !== 'player'
          : !live.state.npcBrains?.[r.npc_id])
      ) {
        await this.db.query(
          "UPDATE game_npc_decision_requests SET status='cancelled',context='{}',result_code='AUTHORIZATION_REVOKED' WHERE id=$1 AND status='queued'",
          [r.id],
        );
        continue;
      }
      if (r.purpose === 'narrative') {
        const turn = (
          await this.db.query(
            "SELECT * FROM game_narrative_turns WHERE id=$1 AND status='pending'",
            [r.id],
          )
        )[0];
        if (turn && new Date(turn.expires_at).getTime() <= Date.now()) {
          await this.db.tx(async (c) => {
            await c.query(
              "UPDATE game_npc_decision_requests SET status='failed',context='{}',result_code='QUOTE_EXPIRED' WHERE id=$1 AND status='queued'",
              [r.id],
            );
            await c.query(
              "UPDATE game_narrative_turns SET status='failed',result_code='QUOTE_EXPIRED' WHERE id=$1 AND status='pending'",
              [r.id],
            );
          });
          continue;
        }
        if (!turn) {
          await this.db.query(
            "UPDATE game_npc_decision_requests SET status='cancelled',context='{}' WHERE id=$1 AND status='queued'",
            [r.id],
          );
          continue;
        }
        if (
          buildNarrativeContext(live.state, String(r.npc_id), String(turn.input_text))
            .contextHash !== r.context.contextHash
        ) {
          await this.db.tx(async (c) => {
            await c.query(
              "UPDATE game_npc_decision_requests SET status='failed',context='{}',result_code='STALE_CANON' WHERE id=$1 AND status='queued'",
              [r.id],
            );
            await c.query(
              "UPDATE game_narrative_turns SET status='stale',result_code='STALE_CANON' WHERE id=$1 AND status='pending'",
              [r.id],
            );
          });
          continue;
        }
        try {
          const job = await this.ai.queue({
            scope: {
              campaignId: id,
              npcId: String(r.npc_id),
              purpose: 'narrative',
              subjectKind: 'player',
              origin: 'user',
              requesterUserId: String(r.requester_user_id),
            },
            context: r.context,
            operationId: r.id,
            requesterUserId: String(r.requester_user_id),
            quoteId: turn.quote_id ?? undefined,
            sponsorId: turn.sponsor_id ?? undefined,
            consent: turn.consent,
            requestKey: `narrative:${turn.operation_id}`,
            runtimeRequestId: r.id,
          });
          await this.db.query(
            "UPDATE game_npc_decision_requests SET status='scheduled',job_id=$2 WHERE id=$1 AND status='queued'",
            [r.id, job.id],
          );
          live.aiPending = true;
          this.dispatchAi(id);
        } catch (error) {
          const message = error instanceof Error ? error.message : '';
          if (message.includes('NPC_AI_BUSY') || message.includes('RATE_LIMITED')) continue;
          await this.db.tx(async (c) => {
            await c.query(
              "UPDATE game_npc_decision_requests SET status='failed',context='{}',result_code='NARRATIVE_UNAVAILABLE' WHERE id=$1 AND status='queued'",
              [r.id],
            );
            await c.query(
              "UPDATE game_narrative_turns SET status='failed',result_code='NARRATIVE_UNAVAILABLE' WHERE id=$1 AND status='pending'",
              [r.id],
            );
          });
        }
        continue;
      }
      const busy = (
        await this.db.query(
          "SELECT status FROM npc_ai_jobs WHERE campaign_id=$1 AND npc_id=$2 AND status IN ('reserved','running','result_received','validated','reconciling')",
          [id, r.npc_id],
        )
      )[0];
      if (busy && busy.status !== 'reconciling') continue;
      const configuration = this.ai.configuration(),
        purpose = r.purpose as AiPurpose;
      const sponsorId = await this.ai.activeSponsor(id, purpose);
      const useProvider =
        configuration.enabled &&
        !busy &&
        !r.context.budgetExceeded &&
        ((configuration.provider === 'mock' && configuration.creditPrice === 0) ||
          Boolean(sponsorId));
      if (!useProvider) {
        const decision = await this.evaluateDecision(id, live.state, {
          id: r.id,
          npcId: r.npc_id,
          purpose,
          context: r.context,
          contextHash: r.context.contextHash,
          proposal: r.context.mockProposal,
        });
        await this.persist(id, live, decision.next, 'npc.local.fallback', undefined, async (c) => {
          const updated = await c.query(
            "UPDATE game_npc_decision_requests SET status='fallback',result_code=$2 WHERE id=$1 AND status='queued' RETURNING id",
            [r.id, decision.accepted ? 'LOCAL_MOCK' : 'STALE_STATE'],
          );
          if (!updated.rowCount) fail(409, 'STALE_STATE', 'STALE_STATE');
          await this.saveIntentOutcome(c, decision.intentOutcome);
        });
        continue;
      }
      try {
        const scope = {
          campaignId: id,
          npcId: String(r.npc_id),
          purpose,
          subjectKind: (purpose === 'intent' ? 'player' : 'npc') as 'player' | 'npc',
          origin: (purpose === 'intent'
            ? 'user'
            : sponsorId || !r.requester_user_id
              ? 'system'
              : 'user') as 'system' | 'user',
          ...((purpose === 'intent' || !sponsorId) && r.requester_user_id
            ? { requesterUserId: String(r.requester_user_id) }
            : {}),
        };
        const job = await this.ai.queue({
          scope,
          operationId: r.id,
          context: r.context,
          sponsorId,
          requestKey: `runtime:${r.cause_key}`,
          runtimeRequestId: r.id,
        });
        await this.db.query(
          "UPDATE game_npc_decision_requests SET status='scheduled',job_id=$2 WHERE id=$1 AND status='queued'",
          [r.id, job.id],
        );
        live.aiPending = true;
        this.dispatchAi(id);
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (message.includes('RATE_LIMITED') || message.includes('NPC_AI_BUSY')) continue;
        const fallback = await this.evaluateDecision(id, live.state, {
          id: r.id,
          npcId: r.npc_id,
          purpose,
          context: r.context,
          contextHash: r.context.contextHash,
          proposal: r.context.mockProposal,
        });
        await this.persist(
          id,
          live,
          fallback.next,
          'npc.decision.fallback',
          undefined,
          async (c) => {
            const changed = await c.query(
              "UPDATE game_npc_decision_requests SET status='fallback',result_code=$2 WHERE id=$1 AND status='queued' RETURNING id",
              [r.id, fallback.accepted ? 'LOCAL_MOCK' : 'STALE_STATE'],
            );
            if (!changed.rowCount) fail(409, 'STALE_STATE', 'STALE_STATE');
            await this.saveIntentOutcome(c, fallback.intentOutcome);
          },
        );
      }
    }
    live.decisionsPending = Boolean(
      (
        await this.db.query(
          "SELECT 1 FROM game_npc_decision_requests WHERE campaign_id=$1 AND status='queued' LIMIT 1",
          [id],
        )
      ).length,
    );
    live.deferredNpcIds = (
      await this.db.query(
        "SELECT npc_id FROM game_npc_decision_requests WHERE campaign_id=$1 AND status='queued' AND purpose='plan' UNION SELECT npc_id FROM npc_ai_jobs WHERE campaign_id=$1 AND purpose='plan' AND status IN ('reserved','running','result_received','validated')",
        [id],
      )
    ).map((r) => String(r.npc_id));
  }
  private async processAi(id: string, live: Live) {
    await this.ai.sweep(id);
    for (const job of await this.ai.ready(id)) {
      const { next, accepted, intentOutcome, narrativeOutcome } = await this.evaluateDecision(
        id,
        live.state,
        job,
      );
      await this.persist(
        id,
        live,
        next,
        accepted ? 'npc.ai.accepted' : 'npc.ai.stale',
        undefined,
        async (c) => {
          await this.ai.finalize(c, job.id, accepted ? 'committed' : 'stale');
          await this.saveIntentOutcome(c, intentOutcome);
          await this.saveNarrativeOutcome(c, id, next, narrativeOutcome);
        },
      );
    }
    live.aiPending = await this.ai.pending(id);
    if (live.aiPending) this.dispatchAi(id);
  }
  async list(req: Request) {
    const u = await this.auth.require(req);
    return {
      campaigns: (
        await this.db.query(
          `SELECT c.id,c.owner_id,c.playable_version,c.status,m.status AS membership,c.source_version_id,v.source_revision,v.package->'compiled'->>'title' AS title FROM game_campaigns c JOIN game_members m ON m.campaign_id=c.id LEFT JOIN game_playable_versions v ON v.id=c.source_version_id WHERE m.user_id=$1 AND m.status IN ('accepted','pending') AND ${sourceAccessSql('$1')} ORDER BY c.created_at DESC LIMIT 100`,
          [u.id],
        )
      ).map((r) => ({
        id: r.id,
        ownerId: r.owner_id,
        playableVersion: r.playable_version,
        status: r.status,
        membership: r.membership,
        title: r.title ?? null,
        playableVersionId: r.source_version_id ?? null,
        sourceRevision: r.source_revision ?? null,
      })),
    };
  }
  async members(req: Request, id: string) {
    const access = await this.access(req, id);
    const rows = await this.db.query(
      "SELECT m.user_id,m.actor_id,m.status,u.handle FROM game_members m JOIN users u ON u.id=m.user_id WHERE m.campaign_id=$1 AND u.deleted_at IS NULL AND (m.status='accepted' OR $2::boolean)",
      [id, access.user.id === access.ownerId],
    );
    return {
      members: rows.map((r) => ({
        userId: r.user_id,
        actorId: r.actor_id,
        username: r.handle,
        status: r.status,
      })),
      ownerId: access.ownerId,
    };
  }
  async create(req: Request, body: unknown) {
    const input = z
      .union([
        z.object({ template: z.literal('observatory-v1'), heroId: z.uuid().optional() }).strict(),
        z.object({ playableVersionId: z.uuid(), heroId: z.uuid().optional() }).strict(),
      ])
      .parse(body);
    const u = await this.auth.require(req);
    const id = randomUUID(),
      actorId = `player-${u.id}`,
      seed = randomInt(1, 2147483647);
    await this.db.tx(async (c) => {
      const count = await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [u.id]);
      if (!count.rowCount) fail(403, 'FORBIDDEN', 'FORBIDDEN');
      const campaigns = await c.query(
        'SELECT count(*)::int AS n FROM game_campaigns WHERE owner_id=$1',
        [u.id],
      );
      if (campaigns.rows[0].n >= 20) fail(429, 'RATE_LIMITED', 'RATE_LIMITED');
      const selectedHero = await readOwnedHero(c, u.id, input.heroId);
      const sourceVersion = 'playableVersionId' in input ? input.playableVersionId : null;
      const state = sourceVersion
        ? await this.playable.resolveForStart(c, u.id, sourceVersion, actorId, seed)
        : createObservatoryState([actorId], seed);
      if (selectedHero) state.entities[actorId].label = selectedHero.name;
      await c.query(
        'INSERT INTO game_campaigns(id,owner_id,playable_version,state,source_version_id) VALUES($1,$2,$3,$4,$5)',
        [id, u.id, sourceVersion ?? 'observatory-v1', JSON.stringify(state), sourceVersion],
      );
      await c.query(
        "INSERT INTO game_members(campaign_id,user_id,actor_id,status) VALUES($1,$2,$3,'accepted')",
        [id, u.id, actorId],
      );
      await pinHero(c, id, u.id, input.heroId, selectedHero);
      await c.query(
        'INSERT INTO game_snapshots(campaign_id,sequence,checksum,state) VALUES($1,0,$2,$3)',
        [id, digest(state), JSON.stringify(state)],
      );
    });
    return { campaignId: id };
  }
  async invite(req: Request, id: string, body: unknown) {
    const { username } = z
      .object({ username: z.string().min(1).max(40) })
      .strict()
      .parse(body);
    const access = await this.access(req, id);
    if (access.user.id !== access.ownerId) fail(403, 'FORBIDDEN', 'FORBIDDEN');
    await this.serial(id, () =>
      this.db.tx(async (c) => {
        await this.access(req, id);
        await c.query('SELECT id FROM game_campaigns WHERE id=$1 FOR UPDATE', [id]);
        const member = await c.query(
          'SELECT id FROM users WHERE lower(handle)=lower($1) AND deleted_at IS NULL',
          [username],
        );
        if (!member.rows[0]) fail(404, 'NOT_FOUND', 'NOT_FOUND');
        const sourceAllowed = await c.query(
          `SELECT c.id FROM game_campaigns c WHERE c.id=$1 AND ${sourceAccessSql('$2')}`,
          [id, member.rows[0].id],
        );
        if (!sourceAllowed.rowCount) fail(403, 'SOURCE_ACCESS_REQUIRED', 'SOURCE_ACCESS_REQUIRED');
        if (member.rows[0].id === access.user.id) fail(400, 'INVALID_ACTION', 'INVALID_ACTION');
        const count = await c.query(
          "SELECT count(*)::int AS n FROM game_members WHERE campaign_id=$1 AND status IN ('pending','accepted')",
          [id],
        );
        if (count.rows[0].n >= 4) fail(409, 'CAMPAIGN_FULL', 'CAMPAIGN_FULL');
        await c.query(
          "INSERT INTO game_members(campaign_id,user_id,actor_id,status) VALUES($1,$2,$3,'pending') ON CONFLICT(campaign_id,user_id) DO UPDATE SET status='pending' WHERE game_members.status='revoked'",
          [id, member.rows[0].id, `player-${member.rows[0].id}`],
        );
      }),
    );
    return { ok: true };
  }
  async accept(req: Request, id: string, body: unknown = {}) {
    const input = gameHeroSelectionSchema.parse(body ?? {});
    const u = await this.auth.require(req);
    z.uuid().parse(id);
    return this.serial(id, async () => {
      await this.auth.require(req);
      const live = await this.load(id);
      const rows = await this.db.query(
        `SELECT m.actor_id,m.status FROM game_members m JOIN game_campaigns c ON c.id=m.campaign_id JOIN users owner ON owner.id=c.owner_id WHERE m.campaign_id=$1 AND m.user_id=$2 AND m.status IN ('pending','accepted') AND c.status='active' AND owner.deleted_at IS NULL AND ${sourceAccessSql('$2')}`,
        [id, u.id],
      );
      if (!rows[0]) fail(403, 'FORBIDDEN', 'FORBIDDEN');
      const pinned = (
        await this.db.query(
          'SELECT hero_id,snapshot FROM game_member_heroes WHERE campaign_id=$1 AND user_id=$2',
          [id, u.id],
        )
      )[0];
      if (
        input.heroId &&
        ((pinned && pinned.hero_id !== input.heroId) || (!pinned && rows[0].status === 'accepted'))
      )
        fail(409, 'HERO_SELECTION_LOCKED', 'HERO_SELECTION_LOCKED');
      if (rows[0].status === 'accepted') return { ok: true };
      const selectedHero = pinned
        ? pinned.snapshot
        : await this.db.tx((c) => readOwnedHero(c, u.id, input.heroId));
      const result = addPlayer(structuredClone(live.state), String(rows[0].actor_id));
      if (result.error) fail(409, result.error, result.error);
      if (selectedHero) result.state.entities[String(rows[0].actor_id)].label = selectedHero.name;
      await this.persist(id, live, result.state, 'member.accepted', undefined, async (c) => {
        const allowed = await c.query(
          `SELECT m.user_id FROM game_members m JOIN game_campaigns c ON c.id=m.campaign_id JOIN users u ON u.id=m.user_id WHERE m.campaign_id=$1 AND m.user_id=$2 AND m.status='pending' AND u.deleted_at IS NULL AND ${sourceAccessSql('$2')}`,
          [id, u.id],
        );
        if (!allowed.rowCount) fail(403, 'FORBIDDEN', 'FORBIDDEN');
        if (!pinned) {
          const current = await readOwnedHero(c, u.id, input.heroId);
          if (digest(current) !== digest(selectedHero)) fail(409, 'HERO_CHANGED', 'HERO_CHANGED');
          await pinHero(c, id, u.id, input.heroId, current);
        }
        await c.query(
          "UPDATE game_members SET status='accepted' WHERE campaign_id=$1 AND user_id=$2 AND status='pending'",
          [id, u.id],
        );
      });
      return { ok: true };
    });
  }
  async selectedHero(req: Request, id: string) {
    const access = await this.access(req, id);
    const row = (
      await this.db.query(
        'SELECT hero_id,snapshot,selected_at FROM game_member_heroes WHERE campaign_id=$1 AND user_id=$2',
        [id, access.user.id],
      )
    )[0];
    if (!row?.snapshot) return { hero: null };
    const { portraitAssetId: _portrait, sourceUpdatedAt: _source, ...data } = row.snapshot;
    void _source;
    return {
      hero: {
        ...data,
        heroId: row.hero_id,
        portraitUrl: _portrait
          ? `/api/v1/game/campaigns/${id}/actors/${access.actorId}/portrait`
          : null,
        selectedAt: row.selected_at.toISOString(),
      },
    };
  }
  async heroPortrait(req: Request, id: string, actorId: string) {
    z.string()
      .regex(/^player-[a-f0-9-]{36}$/)
      .parse(actorId);
    return this.serial(id, async () => {
      const access = await this.access(req, id),
        live = await this.load(id);
      if (!projectState(live.state, access.actorId).entities.some((e) => e.id === actorId))
        fail(404, 'NOT_FOUND', 'NOT_FOUND');
      const row = (
        await this.db.query(
          `SELECT a.filename FROM game_member_heroes h JOIN game_members m ON m.campaign_id=h.campaign_id AND m.user_id=h.user_id JOIN users u ON u.id=h.user_id JOIN game_campaigns c ON c.id=h.campaign_id JOIN assets a ON a.id::text=h.snapshot->>'portraitAssetId' AND a.owner_id=h.user_id WHERE h.campaign_id=$1 AND m.actor_id=$2 AND m.status='accepted' AND u.deleted_at IS NULL AND ${sourceAccessSql('h.user_id')} AND NOT EXISTS(SELECT 1 FROM art_asset_revisions r JOIN art_asset_takedowns t ON t.revision_id=r.id WHERE r.upload_id=a.id)`,
          [id, actorId],
        )
      )[0];
      if (!row || basename(row.filename) !== row.filename) fail(404, 'NOT_FOUND', 'NOT_FOUND');
      try {
        return await readFile(resolve(config.ASSET_DIR, row.filename));
      } catch {
        return fail(404, 'NOT_FOUND', 'NOT_FOUND');
      }
    });
  }
  async revoke(req: Request, id: string, userId: string) {
    z.uuid().parse(userId);
    const access = await this.access(req, id);
    if (access.user.id !== access.ownerId || userId === access.ownerId)
      fail(403, 'FORBIDDEN', 'FORBIDDEN');
    return this.serial(id, async () => {
      await this.access(req, id);
      const live = await this.load(id);
      const state = structuredClone(live.state);
      const actor = state.entities[`player-${userId}`];
      if (actor) {
        actor.path = [];
        actor.movementGeneration = (actor.movementGeneration ?? 0) + 1;
      }
      await this.persist(id, live, state, 'member.revoked', undefined, async (c) => {
        await c.query(
          "UPDATE game_members SET status='revoked' WHERE campaign_id=$1 AND user_id=$2",
          [id, userId],
        );
      });
      return { ok: true };
    });
  }
  private async captureClock(
    state: GameState,
    id: string,
    client?: import('pg').PoolClient,
  ): Promise<RuntimeClock> {
    const now = Date.now();
    const query = client
      ? async (sql: string, values: unknown[]) => (await client.query(sql, values)).rows
      : (sql: string, values: unknown[]) => this.db.query(sql, values);
    const jobs = await query(
      "SELECT id,due_at,deadline_at FROM game_npc_jobs WHERE campaign_id=$1 AND status='queued'",
      [id],
    );
    return {
      paused: false,
      capturedAtMs: now,
      rounds: Object.fromEntries(
        Object.values(state.encounters)
          .filter((e) => e.phase === 'planning')
          .map((e) => [e.id, Math.max(0, e.deadlineMs - now)]),
      ),
      jobs: Object.fromEntries(
        jobs.map((j) => [
          String(j.id),
          {
            dueMs: Math.max(0, new Date(j.due_at).getTime() - now),
            deadlineMs: Math.max(0, new Date(j.deadline_at).getTime() - now),
          },
        ]),
      ),
    };
  }
  private async pause(id: string, live: Live) {
    if (live.paused) return;
    await this.refreshArt(id, live);
    const clock = await this.captureClock(live.state, id);
    const state = structuredClone(live.state);
    for (const entity of Object.values(state.entities))
      if (entity.kind === 'player') {
        entity.path = [];
        entity.movementGeneration = (entity.movementGeneration ?? 0) + 1;
      }
    live.paused = true;
    live.clock = { ...clock, paused: true };
    live.state = state;
    live.dirty = true;
    await this.persist(id, live, state, 'campaign.paused');
  }
  private async touch(id: string, live: Live, actorId: string) {
    live.presence.set(actorId, Date.now());
    live.lastAccess = Date.now();
    if (!live.paused) return;
    const state = structuredClone(live.state),
      now = Date.now();
    for (const encounter of Object.values(state.encounters))
      if (encounter.phase === 'planning')
        encounter.deadlineMs = now + (live.clock.rounds[encounter.id] ?? 0);
    const saved = live.clock;
    live.paused = false;
    try {
      await this.persist(id, live, state, 'campaign.resumed', undefined, async (c) => {
        for (const [jobId, remaining] of Object.entries(saved.jobs))
          await c.query(
            "UPDATE game_npc_jobs SET due_at=to_timestamp($3/1000.0),deadline_at=to_timestamp($4/1000.0) WHERE id=$1 AND campaign_id=$2 AND status='queued'",
            [jobId, id, now + remaining.dueMs, now + remaining.deadlineMs],
          );
      });
    } catch (error) {
      live.paused = true;
      live.clock = saved;
      throw error;
    }
  }
  async keepAlive(req: Request, id: string, epoch: number) {
    return this.serial(id, async () => {
      if (this.stopping) return;
      const access = await this.access(req, id),
        live = this.live.get(id);
      if (!live || epoch !== (live.actorEpochs[access.actorId] ?? live.epoch)) return;
      await this.touch(id, live, access.actorId);
    });
  }
  async connected(req: Request, id: string) {
    return this.serial(id, async () => {
      if (this.stopping) fail(503, 'UNAVAILABLE', 'UNAVAILABLE');
      const access = await this.access(req, id),
        live = await this.load(id);
      await this.touch(id, live, access.actorId);
      const epoch = randomInt(1, 2147483647);
      live.actorEpochs[access.actorId] = epoch;
      const state = structuredClone(live.state),
        actor = state.entities[access.actorId];
      actor.path = [];
      actor.movementGeneration = (actor.movementGeneration ?? 0) + 1;
      await this.persist(id, live, state, 'movement.connected');
      return { actorId: access.actorId, connectionEpoch: epoch };
    });
  }
  async snapshot(req: Request, id: string, markPresence = true) {
    return this.serial(id, async () => {
      if (this.stopping) fail(503, 'UNAVAILABLE', 'UNAVAILABLE');
      const a = await this.access(req, id);
      const live = await this.load(id);
      if (markPresence) await this.touch(id, live, a.actorId);
      return this.envelope(id, live, a.actorId, markPresence);
    });
  }
  private async refreshArt(id: string, live: Live, force = false) {
    if (!force && Date.now() - (this.artCheckedAt.get(id) ?? 0) < 1000) return;
    const ids = [...new Set((live.state.artBindings ?? []).map((b) => b.revisionId))];
    if (!ids.length) {
      this.artCheckedAt.set(id, Date.now());
      return;
    }
    const unavailable = await this.art.unavailableRevisions(ids);
    let changed = false;
    for (const revisionId of ids) {
      if (this.unavailableArt.has(revisionId) !== unavailable.has(revisionId)) changed = true;
      if (unavailable.has(revisionId)) this.unavailableArt.add(revisionId);
      else this.unavailableArt.delete(revisionId);
    }
    this.artCheckedAt.set(id, Date.now());
    if (changed) this.notify(id);
  }
  private project(state: GameState, actorId: string): GameProjection {
    const projection = projectState(state, actorId),
      key = actorId + ':' + state.seed;
    if (projection.artBindings)
      projection.artBindings = projection.artBindings.filter(
        (b) => !this.unavailableArt.has(b.revisionId),
      );
    const hash = digest(semanticGameProjection(projection));
    const prior = this.projections.get(key),
      revision = prior ? (prior.hash === hash ? prior.revision : prior.revision + 1) : 1;
    this.projections.set(key, { hash, revision });
    return { ...projection, revision };
  }
  private async envelope(id: string, live: Live, actorId: string, forceArt = false) {
    await this.refreshArt(id, live, forceArt);
    const projection = this.project(live.state, actorId);
    return {
      type: 'snapshot',
      campaign: live.campaign,
      paused: live.paused,
      serverNowMs: Date.now(),
      streamId: `${id}:${actorId}:${live.actorEpochs[actorId] ?? live.epoch}`,
      projectionRevision: projection.revision,
      connectionEpoch: live.actorEpochs[actorId] ?? live.epoch,
      projection,
    };
  }
  async move(req: Request, id: string, body: unknown) {
    const input = moveSchema.parse(body);
    return this.serial(id, async () => {
      if (this.stopping) fail(503, 'UNAVAILABLE', 'UNAVAILABLE');
      const a = await this.access(req, id);
      const live = await this.load(id);
      await this.touch(id, live, a.actorId);
      if (input.connectionEpoch !== (live.actorEpochs[a.actorId] ?? live.epoch))
        fail(409, 'STALE_STATE', 'STALE_STATE');
      const result = moveInput(live.state, a.actorId, {
        inputSeq: input.inputSeq,
        movementGeneration: input.movementGeneration,
        target: input.target,
      });
      if (result.error) fail(409, result.error, result.error);
      live.state = result.state;
      live.dirty = true;
      live.lastAccess = Date.now();
      return this.envelope(id, live, a.actorId);
    });
  }
  async stop(req: Request, id: string, body: unknown) {
    const input = z.object({ connectionEpoch: z.number().int() }).strict().parse(body);
    return this.serial(id, async () => {
      if (this.stopping) fail(503, 'UNAVAILABLE', 'UNAVAILABLE');
      const a = await this.access(req, id),
        live = await this.load(id);
      await this.touch(id, live, a.actorId);
      if (input.connectionEpoch !== (live.actorEpochs[a.actorId] ?? live.epoch))
        fail(409, 'STALE_STATE', 'STALE_STATE');
      const result = stopMovement(live.state, a.actorId);
      if (result.error) fail(409, result.error, result.error);
      live.state = result.state;
      live.dirty = true;
      live.lastAccess = Date.now();
      this.notify(id);
      return this.envelope(id, live, a.actorId);
    });
  }
  async command(req: Request, id: string, body: unknown, leaseEpoch?: number) {
    const command = commandSchema.parse(body);
    return this.serial(id, async () => {
      if (this.stopping) fail(503, 'UNAVAILABLE', 'UNAVAILABLE');
      const a = await this.access(req, id);
      const live = await this.load(id),
        hash = digest(canonical(command));
      await this.touch(id, live, a.actorId);
      if (leaseEpoch !== undefined && leaseEpoch !== (live.actorEpochs[a.actorId] ?? live.epoch))
        fail(409, 'STALE_STATE', 'STALE_STATE');
      const existing = await this.db.query(
        'SELECT request_hash,result FROM game_operations WHERE campaign_id=$1 AND actor_id=$2 AND operation_id=$3',
        [id, a.actorId, command.operationId],
      );
      if (existing[0]) {
        if (existing[0].request_hash !== hash)
          fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
        // Replay preserves the committed outcome, but must not resurrect withdrawn
        // or no-longer-visible presentation resources from its cached projection.
        await this.refreshArt(id, live, true);
        const replay = structuredClone(existing[0].result);
        if (replay.projection?.artBindings) {
          const visible = new Set(
            (projectState(live.state, a.actorId).artBindings ?? []).map(
              (b) => `${b.slot}:${b.revisionId}`,
            ),
          );
          replay.projection.artBindings = replay.projection.artBindings.filter(
            (b: { slot: string; revisionId: string }) =>
              visible.has(`${b.slot}:${b.revisionId}`) && !this.unavailableArt.has(b.revisionId),
          );
        }
        return replay;
      }
      let result: GameResult;
      let confirmingIntent: string | undefined;
      if (command.type === 'intent.confirm' && command.proposalId) {
        const row = (
          await this.db.query(
            'SELECT * FROM game_player_intent_proposals WHERE id=$1 AND campaign_id=$2 AND requester_user_id=$3 AND actor_id=$4',
            [command.proposalId, id, a.user.id, a.actorId],
          )
        )[0];
        if (!row) fail(404, 'NOT_FOUND', 'NOT_FOUND');
        result =
          row.status !== 'proposed' || Number(row.valid_until_tick) < live.state.tick
            ? { state: live.state, events: [], error: 'STALE_STATE' }
            : confirmPlayerTextIntent(live.state, a.actorId, row.proposal, true);
        if (!result.error) confirmingIntent = String(row.id);
      } else if (
        command.expectedRevision !== undefined &&
        command.expectedRevision !== this.project(live.state, a.actorId).revision
      )
        result = { state: live.state, events: [], error: 'STALE_STATE' };
      else if (command.type === 'npc.request' && (this.npcCooldown.get(id) ?? 0) > Date.now())
        result = { state: live.state, events: [], error: 'RATE_LIMITED' };
      else result = this.execute(live.state, a.actorId, command);
      const npcId = command.npcId ?? command.action?.targetId ?? 'keeper';
      let job: { id: string; proposal: unknown } | undefined;
      if (
        !result.error &&
        command.type === 'npc.request' &&
        live.state.rulesetVersion === 'hybrid-v2'
      ) {
        const pending = await this.db.query(
          "SELECT id FROM game_npc_jobs WHERE campaign_id=$1 AND npc_id=$2 AND status='queued'",
          [id, npcId],
        );
        const count = (
          await this.db.query('SELECT count(*)::int AS n FROM game_npc_jobs WHERE campaign_id=$1', [
            id,
          ])
        )[0];
        if (
          pending.length ||
          count.n >= 1000 ||
          (live.state.npcBrains?.[npcId]?.nextDecisionTick ?? 0) > live.state.tick
        )
          result = { state: live.state, events: [], error: 'RATE_LIMITED' };
        else job = { id: randomUUID(), proposal: createMockNpcPlan(result.state, npcId) };
      }
      const next = result.error
        ? live.state
        : recordNpcEvents(live.state, result.state, result.events, command.operationId).state;
      let decisionRequest: NpcDecisionRequest | undefined;
      if (
        !result.error &&
        command.type === 'npc.speech' &&
        command.speech &&
        command.npcId &&
        next.rulesetVersion === 'hybrid-v3'
      ) {
        const queued = Number(
          (
            await this.db.query(
              "SELECT count(*) FROM game_npc_decision_requests WHERE campaign_id=$1 AND status='queued'",
              [id],
            )
          )[0].count,
        );
        if (queued >= 16) fail(429, 'RATE_LIMITED', 'RATE_LIMITED');
        const replyToObservationId = admittedNpcSpeechObservationId(
          next,
          a.actorId,
          command.npcId,
          command.speech,
        );
        if (!replyToObservationId) fail(409, 'STALE_STATE', 'STALE_STATE');
        const context = this.speechContext(
          next,
          command.npcId,
          a.actorId,
          command.speech.channel,
          undefined,
          command.topicId,
          replyToObservationId,
        );
        decisionRequest = {
          id: randomUUID(),
          npcId: command.npcId,
          purpose: 'speech',
          causeKey: `dialogue:${a.actorId}:${command.operationId}`,
          requesterUserId: a.user.id,
          recipientActorId: a.actorId,
          context: { ...context, mockProposal: createMockNpcPublicResponse(context) },
        };
      }
      const response = {
        ...(decisionRequest ? { decisionRequestId: decisionRequest.id } : {}),
        status: result.error ? 'rejected' : 'committed',
        code: result.error,
        operationId: command.operationId,
        events: projectGameEvents(next, a.actorId, result.events),
        ...(job ? { jobId: job.id } : {}),
        projection: this.project(next, a.actorId),
      };
      await this.persist(
        id,
        live,
        next,
        command.type,
        {
          actorId: a.actorId,
          command,
          hash,
          response,
        },
        async (c) => {
          if (job)
            await c.query(
              "INSERT INTO game_npc_jobs(id,campaign_id,npc_id,requester_actor_id,proposal,due_at,deadline_at) VALUES($1,$2,$3,$4,$5,now()+interval '150 milliseconds',now()+interval '8 seconds')",
              [job.id, id, npcId, a.actorId, JSON.stringify(job.proposal)],
            );
          if (decisionRequest) await insertNpcRequest(c, id, decisionRequest);
          if (confirmingIntent) {
            const changed = await c.query(
              "UPDATE game_player_intent_proposals SET status='confirmed' WHERE id=$1 AND status='proposed' RETURNING id",
              [confirmingIntent],
            );
            if (!changed.rowCount) fail(409, 'STALE_STATE', 'STALE_STATE');
          }
        },
      );
      if (decisionRequest) live.decisionsPending = true;
      if (job) live.npcPending = true;
      if (
        command.type === 'npc.request' &&
        !result.error &&
        live.state.rulesetVersion === 'observatory-v1'
      )
        this.scheduleNpc(id);
      return response;
    });
  }
  private execute(state: GameState, actorId: string, command: Command): GameResult {
    if (command.type === 'action' && command.action)
      return applyAction(state, actorId, command.action);
    if (command.type === 'npc.speech' && command.npcId && command.speech)
      return applyNpcSpeech(state, actorId, command.npcId, command.speech, { suppressReply: true });
    if (command.type === 'npc.promise' && command.npcId && command.promiseId && command.decision)
      return respondNpcObligation(
        state,
        actorId,
        command.npcId,
        command.promiseId,
        command.decision,
      );
    if (command.type === 'encounter.begin') return beginEncounter(state, actorId, Date.now());
    if (command.type === 'encounter.join' && command.encounterId)
      return requestEncounterJoin(state, actorId, command.encounterId);
    if (command.type === 'encounter.end') return requestEncounterEnd(state, actorId);
    if (command.type === 'encounter.intent' && command.intent)
      return submitIntent(state, actorId, command.intent);
    if (command.type === 'npc.request') {
      // Reactive NPCs choose their own bounded routines; a player cannot inject a manual job.
      if (state.rulesetVersion === 'hybrid-v3')
        return { state, events: [], error: 'INVALID_ACTION' };
      const npcId = command.npcId ?? command.action?.targetId ?? 'keeper';
      if (state.rulesetVersion !== 'hybrid-v2')
        return applyAction(state, actorId, { kind: 'talk', targetId: npcId });
      const visible = projectState(state, actorId).entities.find(
        (e) => e.id === npcId && e.kind === 'npc',
      );
      if (!visible) return { state, events: [], error: 'TARGET_UNAVAILABLE' };
      if (visible.encounterId || state.entities[actorId].encounterId)
        return { state, events: [], error: 'WRONG_MODE' };
      return {
        state,
        events: [{ kind: 'npc.requested', actorId, targetId: npcId, mapId: visible.mapId }],
      };
    }
    return { state, events: [], error: 'INVALID_ACTION' };
  }
  private async persist(
    id: string,
    live: Live,
    state: GameState,
    kind: string,
    operation?: {
      actorId: string;
      command: { operationId: string };
      hash: string;
      response: unknown;
    },
    extra?: (c: import('pg').PoolClient) => Promise<void>,
    prepare?: (c: import('pg').PoolClient, state: GameState) => Promise<GameState>,
  ) {
    const seq = live.eventSeq + 1;
    const retentionDue =
      !live.paused &&
      state.rulesetVersion === 'hybrid-v3' &&
      state.tick - live.lastRetentionTick >= 100;
    let savedClock = live.clock;
    let objectiveEvents: GameResult['events'] = [];
    let releasePublication!: () => void;
    const publication = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    this.publications.set(id, publication);
    try {
      await this.db.tx(async (c) => {
        await c.query(
          'SELECT a.id FROM game_campaigns c JOIN game_playable_versions v ON v.id=c.source_version_id JOIN adventures a ON a.id=v.adventure_id WHERE c.id=$1 FOR SHARE OF a',
          [id],
        );
        if (operation) {
          const allowed = await c.query(
            `SELECT c.id FROM game_campaigns c JOIN game_members m ON m.campaign_id=c.id WHERE c.id=$1 AND m.actor_id=$2 AND m.status='accepted' AND ${sourceAccessSql('m.user_id')}`,
            [id, operation.actorId],
          );
          if (!allowed.rowCount) fail(403, 'FORBIDDEN', 'FORBIDDEN');
        }
        if (prepare) state = await prepare(c, state);
        // Completion is derived from committed world state and currently authorized party members.
        // It shares the same transaction as the action result, checkpoint and idempotency receipt.
        if (state.objectives?.length && !live.paused) {
          const members = (
            await c.query(
              `SELECT m.actor_id FROM game_members m JOIN game_campaigns c ON c.id=m.campaign_id JOIN users u ON u.id=m.user_id WHERE c.id=$1 AND m.status='accepted' AND u.deleted_at IS NULL AND ${sourceAccessSql('m.user_id')} FOR SHARE OF m,u`,
              [id],
            )
          ).rows;
          const completed = advanceObjectives(
            state,
            members.map((m) => String(m.actor_id)),
          );
          if (completed.events.length) {
            state = completed.state;
            objectiveEvents = completed.events;
            if (operation) {
              const response = operation.response as {
                projection: GameProjection;
                events: unknown[];
              };
              response.projection = this.project(state, operation.actorId);
              response.events.push(...completed.events);
            }
          }
        }
        const update = await c.query(
          `UPDATE game_campaigns SET state=$1,revision=revision+1,event_seq=$2,updated_at=now() WHERE id=$3 AND revision=$4 AND status='active' AND EXISTS(SELECT 1 FROM users owner WHERE owner.id=game_campaigns.owner_id AND owner.deleted_at IS NULL) AND ${sourceLiveSql('game_campaigns')} RETURNING revision`,
          [JSON.stringify(state), seq, id, live.dbRevision],
        );
        if (!update.rowCount) {
          this.live.delete(id);
          fail(409, 'STALE_STATE', 'STALE_STATE');
        }
        await c.query(
          'INSERT INTO game_events(campaign_id,sequence,kind,payload) VALUES($1,$2,$3,$4)',
          [
            id,
            seq,
            kind,
            JSON.stringify({
              state,
              serverTick: state.tick,
              ...(objectiveEvents.length ? { objectiveEvents } : {}),
            }),
          ],
        );
        await c.query(
          'INSERT INTO game_snapshots(campaign_id,sequence,checksum,state) VALUES($1,$2,$3,$4) ON CONFLICT(campaign_id) DO UPDATE SET sequence=EXCLUDED.sequence,checksum=EXCLUDED.checksum,state=EXCLUDED.state',
          [id, seq, digest(state), JSON.stringify(state)],
        );
        await c.query('INSERT INTO game_outbox(campaign_id,sequence) VALUES($1,$2)', [id, seq]);
        if (operation)
          await c.query(
            'INSERT INTO game_operations(campaign_id,actor_id,operation_id,request_hash,result) VALUES($1,$2,$3,$4,$5)',
            [
              id,
              operation.actorId,
              operation.command.operationId,
              operation.hash,
              JSON.stringify(operation.response),
            ],
          );
        await archiveNpcEpisodes(c, id, state);
        if (extra) await extra(c);
        if (retentionDue) await pruneNpcMemory(c, id, state, seq);
        savedClock = live.paused
          ? { ...live.clock, paused: true }
          : await this.captureClock(state, id, c);
        await c.query('UPDATE game_campaigns SET runtime_clock=$2 WHERE id=$1', [
          id,
          JSON.stringify(savedClock),
        ]);
      });
      live.state = state;
      if (retentionDue) live.lastRetentionTick = state.tick;
      live.clock = savedClock;
      live.dbRevision++;
      live.eventSeq = seq;
      live.dirty = false;
      live.lastCheckpoint = Date.now();
      this.notify(id);
    } finally {
      if (this.publications.get(id) === publication) this.publications.delete(id);
      releasePublication();
    }
  }
  private async advance(id: string) {
    const live = this.live.get(id);
    if (!live || this.stopping) return;
    if (![...live.presence.values()].some((last) => Date.now() - last <= 5000)) {
      if (!live.paused) await this.pause(id, live);
      else if (live.dirty) await this.persist(id, live, live.state, 'campaign.paused.checkpoint');
      // Keep the paused lease briefly so heartbeat grace can recover a stalled tab.
      if (Date.now() - live.lastAccess < 15000) return;
      this.live.delete(id);
      this.artCheckedAt.delete(id);
      this.npcCooldown.delete(id);
      for (const actor of Object.keys(live.state.entities))
        this.projections.delete(actor + ':' + live.state.seed);
      return;
    }
    if (live.paused) return;
    await this.refreshArt(id, live);
    // No catch-up based on user clocks or network packet volume: exactly one fixed simulation step.
    const before = live.state;
    const result = tick(before, 1);
    live.state = recordNpcEvents(
      before,
      result.state,
      result.events,
      `tick-${result.state.tick}`,
    ).state;
    live.dirty = true;
    for (const encounter of Object.values(live.state.encounters))
      if (encounter.phase === 'planning') {
        const resolved = resolveRound(live.state, encounter.id, Date.now());
        if (!resolved.error && resolved.events.length)
          await this.persist(
            id,
            live,
            recordNpcEvents(
              live.state,
              resolved.state,
              resolved.events,
              `round-${encounter.id}-${encounter.round}`,
            ).state,
            'round.resolved',
          );
      }
    if (live.state.rulesetVersion === 'hybrid-v2') {
      if (live.npcPending && live.state.tick % 4 === 0) await this.processNpcJobs(id, live);
      for (const npcId of Object.keys(live.state.npcBrains ?? {})) {
        const beforeNpc = live.state,
          step = stepNpcPlan(beforeNpc, npcId);
        if (!step.error) {
          const next = recordNpcEvents(
            beforeNpc,
            step.state,
            step.events,
            `npc-step-${npcId}-${step.state.tick}`,
          ).state;
          if (step.events.length) await this.persist(id, live, next, 'npc.plan.step');
          else if (next !== beforeNpc) {
            live.state = next;
            live.dirty = true;
          }
        }
      }
    }
    if (live.state.rulesetVersion === 'hybrid-v3') {
      if (live.state.tick % 4 === 0) {
        if (live.aiPending) await this.processAi(id, live);
        await this.processDecisionRequests(id, live);
      }
      // Capture significant evidence before the deterministic director consumes its cause.
      await this.scheduleAutonomousRequests(id, live);
      const beforeNpc = live.state;
      const routine = stepLivingNpcs(beforeNpc, { deferredNpcIds: live.deferredNpcIds });
      if (!routine.error) {
        const next = recordNpcEvents(
          beforeNpc,
          routine.state,
          routine.events,
          `npc-routine-${routine.state.tick}`,
        ).state;
        // Routine decisions and their consequences use the same durable writer as players.
        // No requester impersonation or external provider job is involved.
        if (routine.events.length) await this.persist(id, live, next, 'npc.routine');
        else if (next !== beforeNpc) {
          live.state = next;
          live.dirty = true;
        }
      }
      for (const npcId of Object.keys(live.state.npcBrains ?? {})) {
        const beforePlan = live.state,
          plan = stepNpcPlan(beforePlan, npcId);
        if (!plan.error) {
          const next = recordNpcEvents(
            beforePlan,
            plan.state,
            plan.events,
            `living-plan-${npcId}-${plan.state.tick}`,
          ).state;
          if (plan.events.length) await this.persist(id, live, next, 'npc.living.plan.step');
          else if (next !== beforePlan) {
            live.state = next;
            live.dirty = true;
          }
        }
      }
    }
    if (live.dirty && Date.now() - live.lastCheckpoint >= 1000)
      await this.persist(id, live, live.state, 'movement.checkpoint');
    if (live.state.tick % 2 === 0) this.notify(id);
  }
  private async processNpcJobs(id: string, live: Live) {
    const jobs = await this.db.query(
      "SELECT * FROM game_npc_jobs WHERE campaign_id=$1 AND status='queued' AND due_at<=now() ORDER BY created_at LIMIT 8",
      [id],
    );
    for (const job of jobs) {
      const allowed = await this.db.query(
        `SELECT c.id FROM game_campaigns c JOIN game_members m ON m.campaign_id=c.id JOIN users u ON u.id=m.user_id WHERE c.id=$1 AND m.actor_id=$2 AND m.status='accepted' AND u.deleted_at IS NULL AND ${sourceAccessSql('m.user_id')}`,
        [id, job.requester_actor_id],
      );
      const expired = new Date(job.deadline_at).getTime() < Date.now();
      const result: GameResult = !allowed.length
        ? { state: live.state, events: [], error: 'FORBIDDEN' }
        : expired
          ? { state: live.state, events: [], error: 'STALE_STATE' }
          : acceptNpcPlan(live.state, String(job.npc_id), job.proposal);
      const next = result.error
        ? live.state
        : recordNpcEvents(live.state, result.state, result.events, `npc-job-${job.id}`).state;
      await this.persist(
        id,
        live,
        next,
        result.error ? `npc.plan.fallback.${result.error}` : 'npc.plan.accepted',
        undefined,
        async (c) => {
          if (!result.error) {
            const stillAllowed = await c.query(
              `SELECT c.id FROM game_campaigns c JOIN game_members m ON m.campaign_id=c.id JOIN users u ON u.id=m.user_id WHERE c.id=$1 AND m.actor_id=$2 AND m.status='accepted' AND u.deleted_at IS NULL AND ${sourceAccessSql('m.user_id')}`,
              [id, job.requester_actor_id],
            );
            if (!stillAllowed.rowCount) fail(409, 'STALE_STATE', 'STALE_STATE');
          }
          const updated = await c.query(
            "UPDATE game_npc_jobs SET status=$2,result_code=$3,completed_at=now() WHERE id=$1 AND status='queued' RETURNING id",
            [
              job.id,
              result.error ? (allowed.length ? 'stale' : 'cancelled') : 'accepted',
              result.error ?? null,
            ],
          );
          if (!updated.rowCount) fail(409, 'STALE_STATE', 'STALE_STATE');
        },
      );
    }
    live.npcPending =
      (
        await this.db.query(
          "SELECT id FROM game_npc_jobs WHERE campaign_id=$1 AND status='queued' LIMIT 1",
          [id],
        )
      ).length > 0;
  }
  private scheduleNpc(id: string) {
    if (this.npcJobs.has(id)) return;
    this.npcJobs.add(id);
    this.npcCooldown.set(id, Date.now() + 2000);
    const live = this.live.get(id);
    if (!live) {
      this.npcJobs.delete(id);
      return;
    }
    const proposal = mockNpcDecision(live.state, 'keeper');
    const jobEpoch = live.epoch;
    // Provider boundary is deliberately asynchronous; no SQL lock or simulation tick waits here.
    const handle = setTimeout(() => {
      this.npcTimers.delete(handle);
      if (this.stopping) return;
      void this.serial(id, async () => {
        const current = await this.load(id);
        if (current.epoch !== jobEpoch || current.paused) return;
        const result = validateNpcProposal(current.state, 'keeper', proposal);
        if (!result.error) await this.persist(id, current, result.state, 'npc.decision');
        else await this.persist(id, current, current.state, `npc.fallback.${result.error}`);
      })
        .catch(() => {})
        .finally(() => this.npcJobs.delete(id));
    }, 150);
    this.npcTimers.add(handle);
    handle.unref();
  }
  async disconnected(id: string, actorId: string, leaseEpoch?: number) {
    if (this.stopping) return;
    await this.serial(id, async () => {
      const live = this.live.get(id);
      if (
        !live ||
        (leaseEpoch !== undefined && leaseEpoch !== (live.actorEpochs[actorId] ?? live.epoch))
      )
        return;
      const state = structuredClone(live.state),
        actor = state.entities[actorId];
      if (!actor) return;
      actor.path = [];
      actor.movementGeneration = (actor.movementGeneration ?? 0) + 1;
      // Halting a silent peer is safe even if a database outage delays its checkpoint.
      // Never continue the old hot path while retrying durable persistence.
      live.state = state;
      live.dirty = true;
      live.presence.delete(actorId);
      if (![...live.presence.values()].some((last) => Date.now() - last <= 5000))
        await this.pause(id, live);
      else await this.persist(id, live, state, 'movement.disconnected');
    });
  }
  async delivered(id: string) {
    await this.db.query(
      'UPDATE game_outbox SET delivered_at=now() WHERE campaign_id=$1 AND delivered_at IS NULL',
      [id],
    );
  }
  async onModuleDestroy() {
    this.stopping = true;
    this.listeners.clear();
    for (const timer of this.npcTimers) clearTimeout(timer);
    this.npcTimers.clear();
    for (const callback of this.shutdownCallbacks) callback();
    clearInterval(this.timer);
    for (const [id, live] of this.live)
      await this.serial(id, async () => {
        if (!live.paused) await this.pause(id, live);
        else if (live.dirty) await this.persist(id, live, live.state, 'campaign.paused.checkpoint');
      });
  }
}

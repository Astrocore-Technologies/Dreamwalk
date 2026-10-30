import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import {
  gameActionSchema,
  gameIntentSchema,
  gameMoveSchema,
  npcSpeechSchema,
  type GameState,
  type GameResult,
  type GameProjection,
} from '@dreamwalk/contracts';
import {
  createObservatoryState,
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
  acceptNpcMemorySummary,
  buildNpcPublicSpeechContext,
  commitNpcPublicUtterance,
  canNpcHear,
  npcContextFingerprint,
  recordNpcEvents,
} from '@dreamwalk/game-core';
import { Db } from '../db';
import { NpcAiService } from '../ai/npc-ai.service';
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
    ]),
    encounterId: z
      .string()
      .regex(/^[\w-]+$/)
      .max(100)
      .optional(),
    action: gameActionSchema.optional(),
    speech: npcSpeechSchema.optional(),
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
  private pending = new Map<string, number>();
  private listeners = new Set<(campaignId: string) => void>();
  private npcJobs = new Set<string>();
  private npcTimers = new Set<ReturnType<typeof setTimeout>>();
  private npcCooldown = new Map<string, number>();
  private projections = new Map<string, { hash: string; revision: number }>();
  private timer: ReturnType<typeof setInterval>;
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
  ) {
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
      `SELECT c.*,s.checksum,s.state AS snapshot_state,v.package->'compiled'->>'title' AS game_title,v.source_revision FROM game_campaigns c JOIN game_snapshots s ON s.campaign_id=c.id LEFT JOIN game_playable_versions v ON v.id=c.source_version_id WHERE c.id=$1 AND c.status='active' AND EXISTS(SELECT 1 FROM users owner WHERE owner.id=c.owner_id AND owner.deleted_at IS NULL) AND ${sourceLiveSql()}`,
      [id],
    );
    const row = rows[0];
    if (!row) fail(404, 'NOT_FOUND', 'NOT_FOUND');
    if (digest(row.snapshot_state) !== row.checksum || digest(row.state) !== row.checksum)
      fail(503, 'RECOVERY_REQUIRED', 'RECOVERY_REQUIRED');
    const state = row.state as GameState;
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
    const rows = await this.db.query(
      `SELECT m.actor_id,c.owner_id,c.revision FROM game_members m JOIN game_campaigns c ON c.id=m.campaign_id WHERE m.campaign_id=$1 AND m.user_id=$2 AND m.status='accepted' AND c.status='active' AND EXISTS(SELECT 1 FROM users owner WHERE owner.id=c.owner_id AND owner.deleted_at IS NULL) AND ${sourceAccessSql('$2')}`,
      [id, user.id],
    );
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
    const cached = this.live.get(id);
    if (cached && Number(rows[0].revision) > cached.dbRevision) this.live.delete(id);
    return { user, actorId: String(rows[0].actor_id), ownerId: String(rows[0].owner_id) };
  }
  /** Player-facing metadata only; decision contexts remain server-private. */
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
            ? { code: 'acknowledged' as const }
            : input.purpose === 'summary'
              ? createNpcMemorySummary(live.state, input.npcId)
              : createMockNpcPlan(live.state, input.npcId),
      };
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
    if (purpose !== 'plan') return base;
    const archivedEpisodes = await recallNpcEpisodes(this.db, id, state, npcId);
    return { ...base, archivedEpisodes, contextHash: digest({ base, archivedEpisodes }) };
  }
  private speechContext(
    state: GameState,
    npcId: string,
    recipientId: string,
    channel: 'say' | 'whisper',
    selected?: string[],
    topicId?: string,
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
    if (topicId && !projectState(state, recipientId).entities.some((e) => e.id === topicId))
      fail(404, 'NOT_FOUND', 'NOT_FOUND');
    const memory = state.npcBrains![npcId].living!;
    // Ask permissions derive from an authenticated visible topic, never proposed secret IDs.
    const requestedFactIds = topicId
      ? memory.observations
          .filter(
            (o) =>
              o.targetId === topicId && o.kind === 'known_entity' && o.revealCondition === 'asked',
          )
          .map((o) => o.id)
      : [];
    const observations =
      selected ??
      [...new Set([...requestedFactIds, ...memory.observations.slice(-16).map((o) => o.id)])].slice(
        0,
        16,
      );
    const publicContext = buildNpcPublicSpeechContext(
      state,
      npcId,
      audience,
      observations,
      requestedFactIds,
    );
    const observationIds = publicContext.claims.map((c) => c.observationId);
    const safe = {
      ...publicContext,
      recipientId,
      channel,
      observationIds,
      topicId,
      requestedFactIds,
      speechHash: npcContextFingerprint(publicContext),
    };
    return { ...safe, contextHash: digest(safe) };
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
  private async processAi(id: string, live: Live) {
    await this.ai.sweep(id);
    for (const job of await this.ai.ready(id)) {
      let next = live.state,
        accepted = false;
      const memory = live.state.npcBrains?.[job.npcId]?.living;
      if (memory && job.purpose === 'speech') {
        const request = z
          .object({
            recipientId: z.string(),
            channel: z.enum(['say', 'whisper']),
            observationIds: z.array(z.string()).max(16),
            topicId: z.string().optional(),
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
              live.state,
              job.npcId,
              request.data.recipientId,
              request.data.channel,
              request.data.observationIds,
              request.data.topicId,
            );
          } catch {
            /* No longer nearby/in same phase: stale, never broadcast. */
          }
          if (context?.contextHash === job.contextHash) {
            const result = commitNpcPublicUtterance(live.state, job.npcId, {
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
        (await this.decisionContext(id, live.state, job.npcId, job.purpose)).contextHash ===
          job.contextHash
      ) {
        if (job.purpose === 'plan') {
          const result = acceptNpcPlan(live.state, job.npcId, job.proposal);
          if (!result.error) {
            next = recordNpcEvents(live.state, result.state, result.events, `ai-${job.id}`).state;
            accepted = true;
          }
        } else if (job.purpose === 'summary') {
          const result = acceptNpcMemorySummary(live.state, job.npcId, job.proposal);
          if (!result.error) {
            next = result.state;
            accepted = true;
          }
        }
      }
      await this.persist(
        id,
        live,
        next,
        accepted ? 'npc.ai.accepted' : 'npc.ai.stale',
        undefined,
        (c) => this.ai.finalize(c, job.id, accepted ? 'committed' : 'stale'),
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
        z.object({ template: z.literal('observatory-v1') }).strict(),
        z.object({ playableVersionId: z.uuid() }).strict(),
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
      const sourceVersion = 'playableVersionId' in input ? input.playableVersionId : null;
      const state = sourceVersion
        ? await this.playable.resolveForStart(c, u.id, sourceVersion, actorId, seed)
        : createObservatoryState([actorId], seed);
      await c.query(
        'INSERT INTO game_campaigns(id,owner_id,playable_version,state,source_version_id) VALUES($1,$2,$3,$4,$5)',
        [id, u.id, sourceVersion ?? 'observatory-v1', JSON.stringify(state), sourceVersion],
      );
      await c.query(
        "INSERT INTO game_members(campaign_id,user_id,actor_id,status) VALUES($1,$2,$3,'accepted')",
        [id, u.id, actorId],
      );
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
  async accept(req: Request, id: string) {
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
      if (rows[0].status === 'accepted') return { ok: true };
      const result = addPlayer(live.state, String(rows[0].actor_id));
      if (result.error) fail(409, result.error, result.error);
      await this.persist(id, live, result.state, 'member.accepted', undefined, async (c) => {
        await c.query(
          "UPDATE game_members SET status='accepted' WHERE campaign_id=$1 AND user_id=$2 AND status='pending'",
          [id, u.id],
        );
      });
      return { ok: true };
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
      return this.envelope(id, live, a.actorId);
    });
  }
  private project(state: GameState, actorId: string): GameProjection {
    const projection = projectState(state, actorId),
      key = actorId + ':' + state.seed;
    const hash = digest({ ...projection, tick: 0, revision: 0 });
    const prior = this.projections.get(key),
      revision = prior ? (prior.hash === hash ? prior.revision : prior.revision + 1) : 1;
    this.projections.set(key, { hash, revision });
    return { ...projection, revision };
  }
  private envelope(id: string, live: Live, actorId: string) {
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
        return existing[0].result;
      }
      let result: GameResult;
      if (
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
      const response = {
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
        job
          ? async (c) => {
              await c.query(
                "INSERT INTO game_npc_jobs(id,campaign_id,npc_id,requester_actor_id,proposal,due_at,deadline_at) VALUES($1,$2,$3,$4,$5,now()+interval '150 milliseconds',now()+interval '8 seconds')",
                [job.id, id, npcId, a.actorId, JSON.stringify(job.proposal)],
              );
            }
          : undefined,
      );
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
      return applyNpcSpeech(state, actorId, command.npcId, command.speech);
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
    operation?: { actorId: string; command: Command; hash: string; response: unknown },
    extra?: (c: import('pg').PoolClient) => Promise<void>,
  ) {
    const seq = live.eventSeq + 1;
    let savedClock = live.clock;
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
        [id, seq, kind, JSON.stringify({ state, serverTick: state.tick })],
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
      savedClock = live.paused
        ? { ...live.clock, paused: true }
        : await this.captureClock(state, id, c);
      await c.query('UPDATE game_campaigns SET runtime_clock=$2 WHERE id=$1', [
        id,
        JSON.stringify(savedClock),
      ]);
    });
    live.state = state;
    live.clock = savedClock;
    live.dbRevision++;
    live.eventSeq = seq;
    live.dirty = false;
    live.lastCheckpoint = Date.now();
    this.notify(id);
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
      this.npcCooldown.delete(id);
      for (const actor of Object.keys(live.state.entities))
        this.projections.delete(actor + ':' + live.state.seed);
      return;
    }
    if (live.paused) return;
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
      if (live.aiPending && live.state.tick % 4 === 0) await this.processAi(id, live);
      const beforeNpc = live.state;
      const routine = stepLivingNpcs(beforeNpc);
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

import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import {
  gameActionSchema,
  gameIntentSchema,
  gameMoveSchema,
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
  submitIntent,
  resolveRound,
  projectState,
  mockNpcDecision,
  validateNpcProposal,
} from '@dreamwalk/game-core';
import { Db } from '../db';
import { Auth } from '../auth';
import { fail } from '../errors';

export const commandSchema = z
  .object({
    protocolVersion: z.literal(1),
    operationId: z.uuid(),
    type: z.enum(['action', 'encounter.begin', 'encounter.intent', 'npc.request']),
    action: gameActionSchema.optional(),
    intent: gameIntentSchema.optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
export const moveSchema = gameMoveSchema.extend({ connectionEpoch: z.number().int() }).strict();
type Command = z.infer<typeof commandSchema>;
type Live = {
  state: GameState;
  dbRevision: number;
  eventSeq: number;
  dirty: boolean;
  lastCheckpoint: number;
  lastAccess: number;
  epoch: number;
  actorEpochs: Record<string, number>;
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
      "SELECT c.*,s.checksum,s.state AS snapshot_state FROM game_campaigns c JOIN game_snapshots s ON s.campaign_id=c.id WHERE c.id=$1 AND c.status='active' AND EXISTS(SELECT 1 FROM users owner WHERE owner.id=c.owner_id AND owner.deleted_at IS NULL)",
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
      }
    const live: Live = {
      state,
      dbRevision: Number(row.revision),
      eventSeq: Number(row.event_seq),
      dirty: true,
      lastCheckpoint: Date.now(),
      lastAccess: Date.now(),
      epoch: randomInt(1, 2147483647),
      actorEpochs: {},
    };
    this.live.set(id, live);
    return live;
  }
  async access(req: Request, id: string) {
    z.uuid().parse(id);
    const user = await this.auth.require(req);
    const rows = await this.db.query(
      "SELECT m.actor_id,c.owner_id FROM game_members m JOIN game_campaigns c ON c.id=m.campaign_id WHERE m.campaign_id=$1 AND m.user_id=$2 AND m.status='accepted' AND c.status='active' AND EXISTS(SELECT 1 FROM users owner WHERE owner.id=c.owner_id AND owner.deleted_at IS NULL)",
      [id, user.id],
    );
    if (!rows[0]) fail(403, 'FORBIDDEN', 'FORBIDDEN');
    return { user, actorId: String(rows[0].actor_id), ownerId: String(rows[0].owner_id) };
  }
  async list(req: Request) {
    const u = await this.auth.require(req);
    return {
      campaigns: (
        await this.db.query(
          "SELECT c.id,c.owner_id,c.playable_version,c.status,m.status AS membership FROM game_campaigns c JOIN game_members m ON m.campaign_id=c.id WHERE m.user_id=$1 AND m.status IN ('accepted','pending') ORDER BY c.created_at DESC LIMIT 100",
          [u.id],
        )
      ).map((r) => ({
        id: r.id,
        ownerId: r.owner_id,
        playableVersion: r.playable_version,
        status: r.status,
        membership: r.membership,
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
    z.object({ template: z.literal('observatory-v1') })
      .strict()
      .parse(body);
    const u = await this.auth.require(req);
    const id = randomUUID(),
      actorId = `player-${u.id}`,
      state = createObservatoryState([actorId], randomInt(1, 2147483647));
    await this.db.tx(async (c) => {
      const count = await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [u.id]);
      if (!count.rowCount) fail(403, 'FORBIDDEN', 'FORBIDDEN');
      const campaigns = await c.query(
        'SELECT count(*)::int AS n FROM game_campaigns WHERE owner_id=$1',
        [u.id],
      );
      if (campaigns.rows[0].n >= 20) fail(429, 'RATE_LIMITED', 'RATE_LIMITED');
      await c.query(
        'INSERT INTO game_campaigns(id,owner_id,playable_version,state) VALUES($1,$2,$3,$4)',
        [id, u.id, 'observatory-v1', JSON.stringify(state)],
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
        "SELECT m.actor_id,m.status FROM game_members m JOIN game_campaigns c ON c.id=m.campaign_id JOIN users owner ON owner.id=c.owner_id WHERE m.campaign_id=$1 AND m.user_id=$2 AND m.status IN ('pending','accepted') AND c.status='active' AND owner.deleted_at IS NULL",
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
  async connected(req: Request, id: string) {
    return this.serial(id, async () => {
      if (this.stopping) fail(503, 'UNAVAILABLE', 'UNAVAILABLE');
      const access = await this.access(req, id),
        live = await this.load(id);
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
  async snapshot(req: Request, id: string) {
    return this.serial(id, async () => {
      if (this.stopping) fail(503, 'UNAVAILABLE', 'UNAVAILABLE');
      const a = await this.access(req, id);
      const live = await this.load(id);
      live.lastAccess = Date.now();
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
      const next = result.error ? live.state : result.state;
      const response = {
        status: result.error ? 'rejected' : 'committed',
        code: result.error,
        operationId: command.operationId,
        events: result.events,
        projection: this.project(next, a.actorId),
      };
      await this.persist(id, live, next, command.type, {
        actorId: a.actorId,
        command,
        hash,
        response,
      });
      if (command.type === 'npc.request' && !result.error) this.scheduleNpc(id);
      return response;
    });
  }
  private execute(state: GameState, actorId: string, command: Command): GameResult {
    if (command.type === 'action' && command.action)
      return applyAction(state, actorId, command.action);
    if (command.type === 'encounter.begin') return beginEncounter(state, actorId, Date.now());
    if (command.type === 'encounter.intent' && command.intent)
      return submitIntent(state, actorId, command.intent);
    if (command.type === 'npc.request')
      return applyAction(state, actorId, { kind: 'talk', targetId: 'keeper' });
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
    await this.db.tx(async (c) => {
      const update = await c.query(
        "UPDATE game_campaigns SET state=$1,revision=revision+1,event_seq=$2,updated_at=now() WHERE id=$3 AND revision=$4 AND status='active' AND EXISTS(SELECT 1 FROM users owner WHERE owner.id=game_campaigns.owner_id AND owner.deleted_at IS NULL) RETURNING revision",
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
      if (extra) await extra(c);
    });
    live.state = state;
    live.dbRevision++;
    live.eventSeq = seq;
    live.dirty = false;
    live.lastCheckpoint = Date.now();
    this.notify(id);
  }
  private async advance(id: string) {
    const live = this.live.get(id);
    if (!live || this.stopping) return;
    if (Date.now() - live.lastAccess > 5000) {
      if (live.dirty) await this.persist(id, live, live.state, 'movement.checkpoint');
      this.live.delete(id);
      this.npcCooldown.delete(id);
      for (const actor of Object.keys(live.state.entities))
        this.projections.delete(actor + ':' + live.state.seed);
      return;
    }
    // No catch-up based on user clocks or network packet volume: exactly one fixed simulation step.
    const result = tick(live.state, 1);
    live.state = result.state;
    live.dirty = true;
    for (const encounter of Object.values(live.state.encounters))
      if (encounter.phase === 'planning') {
        const resolved = resolveRound(live.state, encounter.id, Date.now());
        if (!resolved.error && resolved.events.length)
          await this.persist(id, live, resolved.state, 'round.resolved');
      }
    if (live.dirty && Date.now() - live.lastCheckpoint >= 1000)
      await this.persist(id, live, live.state, 'movement.checkpoint');
    if (live.state.tick % 2 === 0) this.notify(id);
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
    // Provider boundary is deliberately asynchronous; no SQL lock or simulation tick waits here.
    const handle = setTimeout(() => {
      this.npcTimers.delete(handle);
      if (this.stopping) return;
      void this.serial(id, async () => {
        const current = await this.load(id);
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
      await this.persist(id, live, state, 'movement.disconnected');
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
        if (live.dirty) await this.persist(id, live, live.state, 'movement.checkpoint');
      });
  }
}

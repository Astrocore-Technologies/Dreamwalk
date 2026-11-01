import { randomUUID } from 'node:crypto';
import { resolveReplyLocale } from './reply-locale';
import type { Request } from 'express';
import type { PoolClient, QueryResultRow } from 'pg';
import {
  storyTurnInputSchema,
  storyTurnSubmitSchema,
  storyTurnConfirmSchema,
  type GameState,
  type Locale,
  type GameResult,
  type StoryActionPreview,
  type StoryTurnSubmit,
  type StoryTurnInput,
  type StoryTurnQuoteResponse,
  type StoryTurnReceipt,
  type StoryTurnFeed,
  type StoryFeedEntry,
} from '@dreamwalk/contracts';
import {
  applyTurnAction,
  parsePlayerTextAction,
  turnFence,
  matchesTurnFence,
  canNpcHear,
  buildStoryTurnContext,
  createMockStoryTurnProposal,
  applyStoryTurnProposal,
  parseStorySegments,
  npcContextFingerprint,
  projectState,
  type StorySafeEntry,
} from '@dreamwalk/game-core';
import { Db } from '../db';
import { NpcAiService } from '../ai/npc-ai.service';
import type { ReadyDecision } from '../ai/types';
import { digest } from '../ai/context';
import { extendContextHistory } from './context-history';
import { fail } from '../errors';
import { sourceAccessSql } from './source-access';
import { insertNpcRequest, type NpcDecisionRequest } from './npc-requests';
export interface StoryLive {
  state: GameState;
  eventSeq: number;
  paused: boolean;
  aiPending: boolean;
  decisionsPending: boolean;
}
interface Port {
  serial<T>(id: string, work: () => Promise<T>): Promise<T>;
  access(
    req: Request,
    id: string,
  ): Promise<{
    user: { id: string; settings?: { language?: Locale } };
    actorId: string;
    ownerId: string;
  }>;
  load(id: string): Promise<StoryLive>;
  touch(id: string, live: StoryLive, actorId: string): Promise<void>;
  persist(
    id: string,
    live: StoryLive,
    state: GameState,
    kind: string,
    extra: (c: PoolClient) => Promise<void>,
    preflight: (c: PoolClient) => Promise<void>,
  ): Promise<void>;
  dispatch(id: string): void;
  prepareTurnSpeech(
    state: GameState,
    actorId: string,
    npcId: string,
    speech: { channel: 'say' | 'whisper'; text: string; replyLocale?: Locale },
    requestId: string,
    userId: string,
    identity: { turnId: string; segmentIndex: number },
  ): {
    state: GameState;
    events: GameResult['events'];
    request: NpcDecisionRequest;
    audienceIds: string[];
    sourceId?: string;
  };
}
type Row = QueryResultRow;
const baseInput = (v: Row): StoryTurnInput =>
  storyTurnInputSchema.parse({
    operationId: v.operationId,
    text: v.text,
    channel: v.channel,
    ...(v.targetNpcId ? { targetNpcId: v.targetNpcId } : {}),
    expectedCanonRevision: v.expectedCanonRevision,
    ...(v.replyLocale ? { replyLocale: v.replyLocale } : {}),
    ...(v.turnFence ? { turnFence: v.turnFence } : {}),
  });
const date = (v: Date | string) => new Date(v).toISOString();
export class StoryTurnRuntime {
  constructor(
    private db: Db,
    private ai: NpcAiService,
    private port: Port,
  ) {}
  private erased(row: Row) {
    if (row.erased_at || row.result_code === 'DATA_ERASED') fail(409, 'DATA_ERASED', 'DATA_ERASED');
  }
  private async authorized(c: PoolClient, id: string, userId: string) {
    // Erasure owns a user row before it reaches campaigns/source rows. Lock
    // every participating user first, in deterministic order, before world locks.
    await c.query(
      `SELECT u.id FROM users u WHERE u.id=$2 OR u.id IN (SELECT m.user_id FROM game_members m WHERE m.campaign_id=$1) OR u.id IN (SELECT a.owner_id FROM game_campaigns c JOIN game_playable_versions v ON v.id=c.source_version_id JOIN adventures a ON a.id=v.adventure_id WHERE c.id=$1) ORDER BY u.id FOR SHARE OF u`,
      [id, userId],
    );
    await c.query(
      'SELECT a.id FROM game_campaigns c JOIN game_playable_versions v ON v.id=c.source_version_id JOIN adventures a ON a.id=v.adventure_id WHERE c.id=$1 FOR SHARE OF a',
      [id],
    );
    await c.query(
      "SELECT i.id FROM game_campaigns c JOIN game_playable_versions v ON v.id=c.source_version_id JOIN adventure_invitations i ON i.adventure_id=v.adventure_id WHERE c.id=$1 AND i.recipient_id=$2 AND i.status='accepted' FOR SHARE OF i",
      [id, userId],
    );
    const active = await c.query(
      `SELECT m.actor_id FROM game_campaigns c JOIN game_members m ON m.campaign_id=c.id JOIN users u ON u.id=m.user_id WHERE c.id=$1 AND m.user_id=$2 AND m.status='accepted' AND u.deleted_at IS NULL AND c.status='active' AND ${sourceAccessSql('$2')} FOR SHARE OF u,m`,
      [id, userId],
    );
    if (!active.rowCount) fail(403, 'FORBIDDEN', 'FORBIDDEN');
  }
  private async row(id: string, turnId: string, userId?: string) {
    return (
      await this.db.query(
        `SELECT t.*,r.status AS request_status,j.status AS job_status,j.credits AS job_credits FROM game_story_turns t LEFT JOIN game_npc_decision_requests r ON r.id=t.decision_request_id LEFT JOIN npc_ai_jobs j ON j.id=r.job_id WHERE t.campaign_id=$1 AND t.id=$2 ${userId ? 'AND t.requester_user_id=$3' : ''}`,
        [id, turnId, ...(userId ? [userId] : [])],
      )
    )[0];
  }
  private receipt(r: Row): StoryTurnReceipt {
    this.erased(r);
    return {
      id: r.id,
      operationId: r.operation_id,
      status: r.status,
      channel: r.input.channel,
      targetNpcId: r.input.targetNpcId,
      inputText: r.input.text,
      createdAt: date(r.created_at),
      ...(r.result_code ? { code: r.result_code } : {}),
      ...(r.job_status ? { jobStatus: r.job_status } : {}),
      ...(r.status === 'awaiting_confirmation'
        ? {
            proposalHash: r.proposal_hash,
            actions: r.result?.actions ?? [],
            confirmationExpiresTick: Number(r.valid_until_tick),
          }
        : {}),
      ...(r.status === 'committed' ? { sceneId: r.result?.sceneId, npcId: r.result?.npcId } : {}),
      generationCost:
        r.job_status === 'committed'
          ? Number(r.job_credits ?? 0)
          : ['stale', 'failed', 'cancelled'].includes(r.job_status)
            ? 0
            : null,
      confirmationCost: 0,
    };
  }
  private async reconcile(id: string, tick: number) {
    await this.db.query(
      `UPDATE game_story_turns t SET status=CASE WHEN t.status='awaiting_confirmation' THEN 'stale' ELSE 'failed' END,result_code=CASE WHEN t.status='awaiting_confirmation' THEN 'CONFIRMATION_EXPIRED' ELSE 'DECISION_UNAVAILABLE' END WHERE t.campaign_id=$1 AND t.erased_at IS NULL AND ((t.status='awaiting_confirmation' AND t.valid_until_tick<$2) OR (t.status='queued' AND NOT EXISTS(SELECT 1 FROM game_npc_decision_requests r LEFT JOIN npc_ai_jobs j ON j.id=r.job_id WHERE r.id=t.decision_request_id AND r.status IN ('queued','scheduled') AND (j.id IS NULL OR j.status NOT IN ('stale','cancelled','failed')))))`,
      [id, tick],
    );
  }
  private simulateTurnPost(
    state: GameState,
    actorId: string,
    input: StoryTurnInput,
    turnId: string,
    userId: string,
  ) {
    const turn = state.turnController;
    if (
      !turn ||
      !input.turnFence ||
      !matchesTurnFence(state, input.turnFence) ||
      turn.phase !== 'player' ||
      turn.activeActorId !== actorId ||
      turn.pendingResolution
    )
      fail(409, 'STALE_STATE', 'STALE_STATE');
    if (input.expectedCanonRevision !== (state.narrativeCanon?.revision ?? 0))
      fail(409, 'STALE_CANON', 'STALE_CANON');
    const parsed = parseStorySegments(input.text);
    if (parsed.code) throw new Error(parsed.code);
    if (input.channel === 'whisper' && !input.targetNpcId)
      throw new Error('PRIVATE_STORY_EXTENSION');
    let next = structuredClone(state);
    const entries: StorySafeEntry[] = [],
      requests: NpcDecisionRequest[] = [],
      actions: StoryActionPreview[] = [];
    const listeners = (s: GameState) =>
      Object.values(s.entities)
        .filter((e) => ['npc', 'player'].includes(e.kind) && canNpcHear(s, e, s.entities[actorId]))
        .map((e) => e.id)
        .sort();
    for (const segment of parsed.segments) {
      if (segment.kind === 'attempt') {
        const action = parsePlayerTextAction(next, actorId, segment.text);
        if (!action) throw new Error('UNSUPPORTED');
        const applied = applyTurnAction(next, actorId, action, input.turnFence!);
        actions.push({
          segmentIndex: segment.index,
          action: action as StoryActionPreview['action'],
        });
        entries.push({
          ordinal: entries.length,
          tick: next.tick,
          kind: 'attempt',
          channel: input.channel,
          authorId: actorId,
          authorLabel: next.entities[actorId].label,
          text: segment.text,
          audienceIds: input.channel === 'whisper' ? [actorId] : listeners(next),
        });
        if (!applied.error) next = applied.state;
        entries.push({
          ordinal: entries.length,
          tick: next.tick,
          kind: 'outcome',
          channel: input.channel,
          code: applied.error ?? 'ACTION_SUCCEEDED',
          action: action as StoryActionPreview['action'],
          audienceIds: input.channel === 'whisper' ? [actorId] : listeners(next),
        });
      } else if (input.targetNpcId) {
        const hash = digest({ turnId, index: segment.index });
        const requestId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
        const spoken = this.port.prepareTurnSpeech(
          next,
          actorId,
          input.targetNpcId,
          { channel: input.channel, text: segment.text, replyLocale: input.replyLocale },
          requestId,
          userId,
          { turnId, segmentIndex: segment.index },
        );
        next = spoken.state;
        requests.push(spoken.request);
        entries.push({
          ordinal: entries.length,
          tick: next.tick,
          kind: 'speech',
          channel: input.channel,
          authorId: actorId,
          authorLabel: next.entities[actorId].label,
          text: segment.text,
          audienceIds: spoken.audienceIds,
          ...(spoken.sourceId ? { sourceId: spoken.sourceId } : {}),
        });
      } else
        entries.push({
          ordinal: entries.length,
          tick: next.tick,
          kind: 'speech',
          channel: 'say',
          authorId: actorId,
          authorLabel: next.entities[actorId].label,
          text: segment.text,
          audienceIds: listeners(next),
        });
    }
    return {
      state: next,
      entries,
      requests,
      actions,
      segments: parsed.segments,
      directorText: !input.targetNpcId
        ? parsed.segments
            .filter((segment) => segment.kind === 'speech')
            .map((segment) => segment.text)
            .join('\n')
        : '',
    };
  }
  private async quoteTurnBased(
    id: string,
    a: { user: { id: string }; actorId: string },
    live: StoryLive,
    input: StoryTurnInput,
  ): Promise<StoryTurnQuoteResponse> {
    const mode = input.targetNpcId ? ('npc' as const) : ('director' as const);
    return this.db.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `story-turn:${id}:${a.user.id}:${input.operationId}`,
      ]);
      await this.authorized(c, id, a.user.id);
      const hash = digest(input),
        old = (
          await c.query(
            'SELECT * FROM game_story_turns WHERE campaign_id=$1 AND requester_user_id=$2 AND operation_id=$3 FOR UPDATE',
            [id, a.user.id, input.operationId],
          )
        ).rows[0];
      if (old) {
        this.erased(old);
        if (old.request_hash !== hash) fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
        return old.quote_result;
      }
      const turnId = randomUUID();
      let simulation: ReturnType<StoryTurnRuntime['simulateTurnPost']>;
      try {
        simulation = this.simulateTurnPost(live.state, a.actorId, input, turnId, a.user.id);
      } catch (error) {
        const code = error instanceof Error ? error.message : 'UNSUPPORTED';
        if (
          [
            'AMBIGUOUS',
            'UNSUPPORTED',
            'WALK_FIRST',
            'PRIVATE_STORY_EXTENSION',
            'INVALID_MARKUP',
            'TOO_MANY_SEGMENTS',
          ].includes(code)
        )
          return {
            status: 'clarification',
            operationId: input.operationId,
            mode,
            segments: parseStorySegments(input.text).segments,
            actionPreview: [],
            code,
          };
        throw error;
      }
      const quote = {
        id: randomUUID(),
        credits: 0,
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        demo: true,
        requiresConsent: false,
        providerUpperMicros: 0,
        provider: 'local-turn-resolver',
        external: false,
        policyVersion: 'dreamwalk-turn-v1',
      };
      const confirmationHash = npcContextFingerprint(simulation.actions);
      const response: StoryTurnQuoteResponse = {
        status: 'quoted',
        operationId: input.operationId,
        turnId,
        mode,
        segments: simulation.segments,
        actionPreview: simulation.actions,
        confirmationHash,
        quote,
      };
      const context = {
        turnBased: true,
        replyLocale: input.replyLocale,
        stateHash: digest(live.state),
        turnFence: turnFence(live.state),
        confirmationHash,
        directorText: simulation.directorText,
      };
      await c.query(
        `INSERT INTO game_story_turns(id,campaign_id,requester_user_id,actor_id,operation_id,request_hash,input,segments,context,quote_id,quote_result,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'quoted')`,
        [
          turnId,
          id,
          a.user.id,
          a.actorId,
          input.operationId,
          hash,
          JSON.stringify(input),
          JSON.stringify(simulation.segments),
          JSON.stringify(context),
          quote.id,
          JSON.stringify(response),
        ],
      );
      return response;
    });
  }
  private async submitTurnBased(
    id: string,
    a: { user: { id: string }; actorId: string },
    live: StoryLive,
    input: StoryTurnSubmit,
    base: StoryTurnInput,
    r: Row,
  ) {
    if (r.request_hash !== digest(base) || r.quote_id !== input.quoteId)
      fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
    if (r.status !== 'quoted') return this.receipt(r);
    if (
      r.context.stateHash !== digest(live.state) ||
      new Date(r.quote_result.quote.expiresAt).getTime() <= Date.now() ||
      input.confirmedActionHash !== r.context.confirmationHash
    )
      fail(409, 'STALE_STATE', 'STALE_STATE');
    const simulation = this.simulateTurnPost(live.state, a.actorId, base, r.id, a.user.id);
    await this.port.touch(id, live, a.actorId);
    const sequence = live.eventSeq + 1;
    await this.port.persist(
      id,
      live,
      simulation.state,
      'turn.post.committed',
      async (c) => {
        await this.authorized(c, id, a.user.id);
        const lock = (
          await c.query('SELECT status FROM game_story_turns WHERE id=$1 FOR UPDATE', [r.id])
        ).rows[0];
        if (lock?.status !== 'quoted') fail(409, 'STALE_STATE', 'STALE_STATE');
        for (const request of simulation.requests) await insertNpcRequest(c, id, request);
        if (simulation.directorText) {
          await insertNpcRequest(c, id, {
            id: r.id,
            npcId: a.actorId,
            purpose: 'story_turn',
            causeKey: `turn-director:${r.id}`,
            requesterUserId: a.user.id,
            recipientActorId: a.actorId,
            context: {
              contextHash: digest({ id: r.id }),
              replyLocale: base.replyLocale,
              turnBasedDeferredDirector: true,
            },
          });
        }
        await c.query(
          "UPDATE game_story_turns SET status='committed',result_code=$2,confirmed_action_hash=$3,result=$4,submitted_sequence=$5,committed_sequence=$5,submitted_at=now(),committed_at=now(),decision_request_id=$6 WHERE id=$1",
          [
            r.id,
            simulation.requests.length || simulation.directorText ? 'NPC_REPLY_DEFERRED' : null,
            input.confirmedActionHash,
            JSON.stringify({ actions: simulation.actions }),
            sequence,
            simulation.directorText ? r.id : null,
          ],
        );
        await this.writeFeed(c, id, r.id, sequence, simulation.entries);
      },
      (c) => this.authorized(c, id, a.user.id),
    );
    if (simulation.requests.length || simulation.directorText) live.decisionsPending = true;
    return this.receipt((await this.row(id, r.id, a.user.id))!);
  }
  async quote(req: Request, id: string, body: unknown): Promise<StoryTurnQuoteResponse> {
    const input = storyTurnInputSchema.parse(body);
    return this.port.serial(id, async () => {
      const a = await this.port.access(req, id),
        live = await this.port.load(id);
      input.replyLocale = resolveReplyLocale(req, input.replyLocale, a.user.settings?.language);
      if (live.state.turnController) return this.quoteTurnBased(id, a, live, input);
      if (live.state.rulesetVersion !== 'hybrid-v3')
        fail(409, 'NARRATIVE_RULESET_REQUIRED', 'NARRATIVE_RULESET_REQUIRED');
      const parsed = parseStorySegments(input.text),
        mode = input.targetNpcId ? ('npc' as const) : ('director' as const);
      if (parsed.code || (input.channel === 'whisper' && !input.targetNpcId))
        return {
          status: 'clarification',
          operationId: input.operationId,
          mode,
          segments: parsed.segments,
          actionPreview: [],
          code: parsed.code ?? 'PRIVATE_STORY_EXTENSION',
        };
      const hash = digest(input);
      return this.db.tx(async (c) => {
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `story-turn:${id}:${a.user.id}:${input.operationId}`,
        ]);
        await this.authorized(c, id, a.user.id);
        const old = (
          await c.query(
            'SELECT * FROM game_story_turns WHERE campaign_id=$1 AND requester_user_id=$2 AND operation_id=$3 FOR UPDATE',
            [id, a.user.id, input.operationId],
          )
        ).rows[0];
        if (old) {
          this.erased(old);
          if (old.request_hash !== hash) fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
          if (
            old.status === 'quoted' &&
            new Date(old.quote_result?.quote?.expiresAt).getTime() <= Date.now()
          )
            fail(409, 'QUOTE_EXPIRED', 'QUOTE_EXPIRED');
          return old.quote_result;
        }
        const count = Number(
          (
            await c.query(
              'SELECT count(*) AS n FROM game_story_turns WHERE campaign_id=$1 AND requester_user_id=$2',
              [id, a.user.id],
            )
          ).rows[0].n,
        );
        if (count >= 1024) fail(429, 'TURN_LIMIT', 'TURN_LIMIT');
        const turnId = randomUUID();
        let context!: ReturnType<typeof buildStoryTurnContext>;
        try {
          context = buildStoryTurnContext(live.state, a.actorId, input, turnId);
        } catch (e) {
          const code = e instanceof Error ? e.message : 'UNSUPPORTED';
          if (['WALK_FIRST', 'UNSUPPORTED', 'PRIVATE_STORY_EXTENSION'].includes(code))
            return {
              status: 'clarification',
              operationId: input.operationId,
              mode,
              segments: parsed.segments,
              actionPreview: [],
              code,
            };
          fail(409, code, code);
        }
        const stored = await extendContextHistory(
          this.db,
          this.ai,
          id,
          live.state,
          a.actorId,
          {
            ...context,
            mockProposal: createMockStoryTurnProposal(live.state, a.actorId, input, turnId),
          },
          'story_turn',
          input.targetNpcId,
        );
        if (
          stored.budgetExceeded ||
          Buffer.byteLength(JSON.stringify(stored)) > this.ai.contextBudgetBytes() ||
          !this.ai.contextFits('story_turn', stored)
        )
          fail(413, 'CONTEXT_BUDGET_EXCEEDED', 'CONTEXT_BUDGET_EXCEEDED');
        const quote = await this.ai.quote(
          {
            campaignId: id,
            npcId: a.actorId,
            subjectKind: 'player',
            origin: 'user',
            purpose: 'story_turn',
            requesterUserId: a.user.id,
          },
          stored,
          a.user.id,
          c,
        );
        const response: StoryTurnQuoteResponse = {
          status: 'quoted',
          operationId: input.operationId,
          turnId,
          mode,
          segments: context.segments,
          actionPreview: context.actionPreview,
          confirmationHash: context.confirmationHash,
          quote,
        };
        await c.query(
          `INSERT INTO game_story_turns(id,campaign_id,requester_user_id,actor_id,operation_id,request_hash,input,segments,context,quote_id,quote_result,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'quoted')`,
          [
            turnId,
            id,
            a.user.id,
            a.actorId,
            input.operationId,
            hash,
            JSON.stringify(input),
            JSON.stringify(context.segments),
            JSON.stringify(stored),
            quote.id,
            JSON.stringify(response),
          ],
        );
        return response;
      });
    });
  }
  async submit(req: Request, id: string, body: unknown) {
    const input = storyTurnSubmitSchema.parse(body);
    return this.port.serial(id, async () => {
      const a = await this.port.access(req, id),
        live = await this.port.load(id),
        r = await this.row(id, input.turnId, a.user.id);
      if (!r) fail(404, 'NOT_FOUND', 'NOT_FOUND');
      this.erased(r);
      // A quote owns its output language. Account/header changes while confirming
      // cannot retarget an already quoted or deferred operation. Legacy clients
      // may omit it, but an explicit different language remains a conflict.
      const base = baseInput({ ...input, replyLocale: input.replyLocale ?? r.input.replyLocale });
      if (live.state.turnController && r.context.turnBased)
        return this.submitTurnBased(id, a, live, input, base, r);
      if (r.request_hash !== digest(base) || r.quote_id !== input.quoteId)
        fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
      if (r.status !== 'quoted') {
        if ((r.confirmed_action_hash ?? undefined) !== input.confirmedActionHash)
          fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
        return this.receipt(r);
      }
      if (input.confirmedActionHash && input.confirmedActionHash !== r.context.confirmationHash)
        fail(409, 'STALE_STATE', 'STALE_STATE');
      if (new Date(r.quote_result.quote.expiresAt).getTime() <= Date.now())
        fail(409, 'QUOTE_EXPIRED', 'QUOTE_EXPIRED');
      let current!: ReturnType<typeof buildStoryTurnContext>;
      try {
        current = buildStoryTurnContext(live.state, a.actorId, base, r.id);
      } catch {
        fail(409, 'STALE_STATE', 'STALE_STATE');
      }
      if (current.contextHash !== r.context.contextHash) fail(409, 'STALE_STATE', 'STALE_STATE');
      const count = Number(
        (
          await this.db.query(
            "SELECT count(*) AS n FROM game_story_turns WHERE campaign_id=$1 AND requester_user_id=$2 AND status IN ('queued','awaiting_confirmation')",
            [id, a.user.id],
          )
        )[0].n,
      );
      if (count >= 2) fail(429, 'RATE_LIMITED', 'RATE_LIMITED');
      await this.port.touch(id, live, a.actorId);
      const sequence = live.eventSeq + 1;
      await this.port.persist(
        id,
        live,
        live.state,
        'story.turn.requested',
        async (c) => {
          await this.authorized(c, id, a.user.id);
          const lock = (
            await c.query('SELECT * FROM game_story_turns WHERE id=$1 FOR UPDATE', [r.id])
          ).rows[0];
          if (!lock) fail(409, 'STALE_STATE', 'STALE_STATE');
          this.erased(lock);
          if (lock.status !== 'quoted') fail(409, 'STALE_STATE', 'STALE_STATE');
          await insertNpcRequest(c, id, {
            id: r.id,
            npcId: a.actorId,
            purpose: 'story_turn',
            causeKey: `story:${r.id}`,
            requesterUserId: a.user.id,
            recipientActorId: a.actorId,
            context: r.context,
          });
          await c.query(
            "UPDATE game_story_turns SET status='queued',decision_request_id=id,confirmed_action_hash=$2,submitted_at=now(),submitted_sequence=$3 WHERE id=$1",
            [r.id, input.confirmedActionHash ?? null, sequence],
          );
        },
        (c) => this.authorized(c, id, a.user.id),
      );
      live.decisionsPending = true;
      return this.receipt((await this.row(id, r.id, a.user.id))!);
    });
  }
  async schedule(id: string, live: StoryLive, request: Row) {
    const r = await this.row(id, request.id);
    if (r?.context.turnBased && r.context.directorText && request.context.turnBasedDeferredDirector)
      return this.scheduleTurnDirector(id, live, request, r);
    if (!r || r.erased_at || r.status !== 'queued') {
      await this.db.query(
        "UPDATE game_npc_decision_requests SET status='cancelled',context='{}',result_code='TURN_UNAVAILABLE' WHERE id=$1 AND status='queued'",
        [request.id],
      );
      return;
    }
    try {
      const context = buildStoryTurnContext(live.state, r.actor_id, r.input, r.id);
      if (context.contextHash !== r.context.contextHash) throw new Error('STALE_STATE');
      await this.ai.queue({
        scope: {
          campaignId: id,
          npcId: r.actor_id,
          subjectKind: 'player',
          origin: 'user',
          purpose: 'story_turn',
          requesterUserId: r.requester_user_id,
        },
        requesterUserId: r.requester_user_id,
        operationId: r.id,
        quoteId: r.quote_id,
        consent: true,
        context: r.context,
        requestKey: `story:${r.id}`,
        runtimeRequestId: r.id,
      });
      live.aiPending = true;
      this.port.dispatch(id);
    } catch (e) {
      const code = e instanceof Error ? e.message : 'DECISION_UNAVAILABLE';
      if (code.includes('NPC_AI_BUSY') || code.includes('RATE_LIMITED')) return;
      await this.db.tx(async (c) => {
        await c.query(
          "UPDATE game_story_turns SET status='stale',result_code=$2 WHERE id=$1 AND status='queued' AND erased_at IS NULL",
          [r.id, code.includes('QUOTE') ? 'QUOTE_EXPIRED' : 'STALE_STATE'],
        );
        await c.query(
          "UPDATE game_npc_decision_requests SET status='failed',context='{}',result_code='STALE_STATE' WHERE id=$1 AND status='queued'",
          [r.id],
        );
      });
    }
  }
  private async scheduleTurnDirector(id: string, live: StoryLive, request: Row, r: Row) {
    if (live.state.turnController?.phase !== 'world') return;
    const configuration = this.ai.configuration();
    // A future paid world director needs its own reviewed quote/sponsor flow. Never
    // turn the free mechanical quote into permission for a real request.
    if (
      !this.ai.manualLive() &&
      (configuration.provider !== 'mock' || configuration.creditPrice !== 0)
    ) {
      await this.db.query(
        "UPDATE game_npc_decision_requests SET status='failed',result_code='TURN_PROVIDER_CONSENT_REQUIRED' WHERE id=$1 AND status='queued'",
        [request.id],
      );
      return;
    }
    const busy = await this.db.query(
      "SELECT 1 FROM npc_ai_jobs WHERE campaign_id=$1 AND npc_id=$2 AND status IN ('reserved','running','result_received','validated') LIMIT 1",
      [id, r.actor_id],
    );
    if (busy.length) return;
    try {
      const worldInput = {
        ...r.input,
        text: r.context.directorText,
        expectedCanonRevision: live.state.narrativeCanon?.revision ?? 0,
        turnFence: turnFence(live.state),
      };
      const base = buildStoryTurnContext(live.state, r.actor_id, worldInput, r.id);
      const context =
        this.ai.contextWindow() &&
        r.context.historyPolicy &&
        r.context.contextHash === base.contextHash &&
        digest(r.context.turnFence) === digest(turnFence(live.state))
          ? r.context
          : await extendContextHistory(
              this.db,
              this.ai,
              id,
              live.state,
              r.actor_id,
              {
                ...r.context,
                ...base,
                worldInput,
                turnBasedDeferredDirector: true,
                turnFence: turnFence(live.state),
                mockProposal: createMockStoryTurnProposal(live.state, r.actor_id, worldInput, r.id),
              },
              'story_turn',
            );
      const scope = {
        campaignId: id,
        npcId: r.actor_id,
        subjectKind: 'player' as const,
        origin: 'user' as const,
        purpose: 'story_turn' as const,
        requesterUserId: r.requester_user_id,
      };
      if (context !== r.context) {
        await this.db.query(
          "UPDATE game_npc_decision_requests SET context=$2 WHERE id=$1 AND status='queued'",
          [request.id, JSON.stringify(context)],
        );
        await this.db.query(
          'UPDATE game_story_turns SET context=$2 WHERE id=$1 AND erased_at IS NULL',
          [r.id, JSON.stringify(context)],
        );
      }
      if (
        this.ai.manualLive() &&
        !(await this.ai.manualRequestAuthorized(String(request.id), context))
      )
        return;
      const quote = await this.ai.quote(scope, context, r.requester_user_id);
      await this.ai.queue({
        scope,
        requesterUserId: r.requester_user_id,
        operationId: r.id,
        quoteId: quote.id,
        consent: true,
        context,
        requestKey: `turn-director:${r.id}`,
        runtimeRequestId: r.id,
      });
      live.aiPending = true;
      this.port.dispatch(id);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code.includes('NPC_AI_BUSY') || code.includes('RATE_LIMITED')) return;
      await this.db.query(
        "UPDATE game_npc_decision_requests SET status='failed',result_code='WORLD_DECISION_UNAVAILABLE' WHERE id=$1 AND status='queued'",
        [request.id],
      );
    }
  }
  async writeDeferredReply(
    c: PoolClient,
    id: string,
    before: GameState,
    next: GameState,
    context: Record<string, unknown>,
    sequence: number,
  ) {
    const turnId = typeof context.storyTurnId === 'string' ? context.storyTurnId : null;
    if (
      !turnId ||
      !(
        await c.query(
          'SELECT id FROM game_story_turns WHERE id=$1 AND campaign_id=$2 AND erased_at IS NULL',
          [turnId, id],
        )
      ).rowCount
    )
      return;
    const source = next.npcUtterances?.find(
      (entry) =>
        !before.npcUtterances?.some((old) => old.id === entry.id) &&
        entry.sourceObservationIds?.includes(String(context.replyToObservationId)),
    );
    if (!source) return;
    await this.writeFeed(c, id, turnId, sequence, [
      {
        ordinal: 1000 + Number(context.turnOrder ?? 0),
        tick: source.tick,
        kind: 'npc_reply',
        channel: context.channel === 'whisper' ? 'whisper' : 'say',
        authorId: source.speakerId,
        authorLabel: next.entities[source.speakerId ?? '']?.label,
        ...(source.text ? { text: source.text } : {}),
        ...(source.code ? { code: source.code } : {}),
        sourceId: source.id,
        audienceIds: source.audienceIds,
      },
    ]);
    await c.query(
      "UPDATE game_story_turns SET result_code=NULL WHERE id=$1 AND result_code='NPC_REPLY_DEFERRED' AND NOT EXISTS(SELECT 1 FROM game_npc_decision_requests r WHERE r.campaign_id=$2 AND r.context->>'storyTurnId'=$1::text AND r.status IN ('queued','scheduled'))",
      [turnId, id],
    );
  }
  private async writeFeed(
    c: PoolClient,
    id: string,
    turnId: string,
    sequence: number,
    entries: StorySafeEntry[],
  ) {
    for (const item of entries) {
      const { audienceIds, ...entry } = item;
      await c.query(
        'INSERT INTO game_story_feed(id,turn_id,campaign_id,sequence,ordinal,tick,channel,audience_ids,entry) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          randomUUID(),
          turnId,
          id,
          sequence,
          entry.ordinal,
          entry.tick,
          entry.channel,
          audienceIds,
          JSON.stringify(entry),
        ],
      );
    }
  }
  async complete(id: string, live: StoryLive, job: ReadyDecision) {
    const r = await this.row(id, String(job.context.turnId));
    const deferredDirector = !!r?.context.turnBasedDeferredDirector;
    if (
      !r ||
      r.erased_at ||
      (deferredDirector ? r.status !== 'committed' : r.status !== 'queued') ||
      (live.state.turnController &&
        (!job.context.turnFence ||
          !matchesTurnFence(live.state, job.context.turnFence) ||
          live.state.turnController.phase !== 'world')) ||
      r.actor_id !== job.npcId ||
      r.requester_user_id !== job.requesterUserId ||
      r.context.contextHash !== job.contextHash
    ) {
      await this.db.tx((c) => this.ai.finalize(c, job.id, 'stale'));
      return;
    }
    const applied = applyStoryTurnProposal(
      live.state,
      r.actor_id,
      deferredDirector ? r.context.worldInput : r.input,
      r.id,
      job.proposal,
    );
    const requiresConfirmation =
      !deferredDirector &&
      !applied.error &&
      !applied.clarification &&
      applied.actions.length > 0 &&
      r.confirmed_action_hash !== npcContextFingerprint(applied.actions);
    const status = applied.error
      ? 'stale'
      : applied.clarification
        ? 'clarification'
        : requiresConfirmation
          ? 'awaiting_confirmation'
          : 'committed';
    const next = status === 'committed' ? applied.state : live.state;
    const sequence = live.eventSeq + 1,
      proposalHash = digest({ turnId: r.id, contextHash: job.contextHash, proposal: job.proposal });
    const canon =
      status === 'committed' ? next.narrativeCanon?.turns.find((t) => t.id === r.id) : undefined;
    await this.port.persist(
      id,
      live,
      next,
      `story.turn.${status}`,
      async (c) => {
        await this.authorized(c, id, r.requester_user_id);
        const lock = (
          await c.query(
            'SELECT t.*,d.status AS decision_status,d.job_id FROM game_story_turns t LEFT JOIN game_npc_decision_requests d ON d.id=t.decision_request_id WHERE t.id=$1 FOR UPDATE OF t',
            [r.id],
          )
        ).rows[0];
        if (!lock) fail(409, 'STALE_STATE', 'STALE_STATE');
        this.erased(lock);
        if (
          (deferredDirector ? lock.status !== 'committed' : lock.status !== 'queued') ||
          lock.decision_status !== 'scheduled' ||
          lock.job_id !== job.id
        )
          fail(409, 'STALE_STATE', 'STALE_STATE');
        await this.ai.finalize(c, job.id, applied.error ? 'stale' : 'committed');
        await c.query(
          'UPDATE game_story_turns SET status=$2,result_code=$3,proposal=$4,proposal_hash=$5,result=$6,valid_until_tick=$7,committed_sequence=$8,committed_at=now() WHERE id=$1',
          [
            r.id,
            status,
            applied.error ?? applied.clarification ?? null,
            JSON.stringify(job.proposal),
            proposalHash,
            JSON.stringify({
              actions: applied.actions,
              sceneId: canon?.sceneId,
              npcId: canon?.npcId,
            }),
            live.state.tick + 1200,
            sequence,
          ],
        );
        await c.query(
          'UPDATE game_npc_decision_requests SET status=$2,result_code=$3 WHERE id=$1',
          [
            r.id,
            applied.error ? 'failed' : 'committed',
            applied.error ?? applied.clarification ?? null,
          ],
        );
        if (status === 'committed')
          await this.writeFeed(
            c,
            id,
            r.id,
            sequence,
            deferredDirector
              ? applied.entries
                  .filter((entry) => !['attempt', 'speech'].includes(entry.kind))
                  .map((entry, i) => ({ ...entry, ordinal: 100 + i }))
              : applied.entries,
          );
        else if (status === 'clarification')
          await this.writeFeed(c, id, r.id, sequence, [
            {
              ordinal: 0,
              tick: live.state.tick,
              kind: 'outcome',
              channel: r.input.channel,
              code: applied.clarification,
              audienceIds: [r.actor_id],
            },
          ]);
      },
      (c) => this.authorized(c, id, r.requester_user_id),
    );
  }
  async confirm(req: Request, id: string, turnId: string, body: unknown) {
    const input = storyTurnConfirmSchema.parse(body),
      hash = digest(input);
    return this.port.serial(id, async () => {
      const a = await this.port.access(req, id),
        live = await this.port.load(id),
        r = await this.row(id, turnId, a.user.id);
      if (!r) fail(404, 'NOT_FOUND', 'NOT_FOUND');
      this.erased(r);
      if (r.confirmation_operation_id) {
        if (
          r.confirmation_operation_id !== input.operationId ||
          r.confirmation_request_hash !== hash
        )
          fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
        return this.receipt(r);
      }
      if (r.status !== 'awaiting_confirmation' || r.proposal_hash !== input.proposalHash)
        fail(409, 'STALE_STATE', 'STALE_STATE');
      await this.port.touch(id, live, a.actorId);
      const applied =
        input.decision === 'accept' && Number(r.valid_until_tick) >= live.state.tick
          ? applyStoryTurnProposal(live.state, a.actorId, r.input, r.id, r.proposal)
          : undefined;
      const status =
        input.decision === 'decline'
          ? 'declined'
          : !applied || applied.error || applied.clarification
            ? 'stale'
            : 'committed';
      const next = status === 'committed' ? applied!.state : live.state,
        sequence = live.eventSeq + 1;
      const canon =
        status === 'committed' ? next.narrativeCanon?.turns.find((t) => t.id === r.id) : undefined;
      await this.port.persist(
        id,
        live,
        next,
        `story.turn.${status}`,
        async (c) => {
          await this.authorized(c, id, a.user.id);
          const lock = (
            await c.query('SELECT * FROM game_story_turns WHERE id=$1 FOR UPDATE', [r.id])
          ).rows[0];
          if (!lock) fail(409, 'STALE_STATE', 'STALE_STATE');
          this.erased(lock);
          if (lock.status !== 'awaiting_confirmation' || lock.proposal_hash !== input.proposalHash)
            fail(409, 'STALE_STATE', 'STALE_STATE');
          await c.query(
            'UPDATE game_story_turns SET status=$2,result_code=$3,confirmation_operation_id=$4,confirmation_request_hash=$5,committed_sequence=$6,committed_at=now(),result=$7 WHERE id=$1',
            [
              r.id,
              status,
              status === 'stale' ? 'STALE_STATE' : null,
              input.operationId,
              hash,
              sequence,
              JSON.stringify({
                actions: applied?.actions ?? [],
                sceneId: canon?.sceneId,
                npcId: canon?.npcId,
              }),
            ],
          );
          if (status === 'committed') await this.writeFeed(c, id, r.id, sequence, applied!.entries);
        },
        (c) => this.authorized(c, id, a.user.id),
      );
      return this.receipt((await this.row(id, r.id, a.user.id))!);
    });
  }
  async feed(req: Request, id: string): Promise<StoryTurnFeed> {
    return this.port.serial(id, async () => {
      const a = await this.port.access(req, id),
        live = await this.port.load(id);
      await this.reconcile(id, live.state.tick);
      const rows = await this.db.query(
        `SELECT f.* FROM game_story_feed f JOIN game_story_turns t ON t.id=f.turn_id WHERE f.campaign_id=$1 AND t.erased_at IS NULL AND ('*'=ANY(f.audience_ids) OR $2=ANY(f.audience_ids)) ORDER BY f.sequence DESC,f.ordinal DESC LIMIT 300`,
        [id, a.actorId],
      );
      const sources = new Set<string>(rows.map((r) => r.entry.sourceId).filter(Boolean));
      const entries: StoryFeedEntry[] = rows.reverse().map((r) => ({
        ...r.entry,
        id: r.id,
        turnId: r.turn_id,
        sequence: Number(r.sequence),
        ordinal: r.ordinal,
        tick: Number(r.tick),
        createdAt: date(r.created_at),
      }));
      for (const entry of entries)
        delete (entry as StoryFeedEntry & { sourceId?: string }).sourceId;
      const turnIds = new Set(entries.map((e) => e.turnId));
      const view = projectState(live.state, a.actorId);
      const legacy: StoryFeedEntry[] = [];
      for (const u of view.npcUtterances ?? []) {
        if (sources.has(u.id)) continue;
        legacy.push({
          id: `legacy-speech:${u.id}`,
          sequence: null,
          ordinal: 0,
          tick: u.tick,
          createdAt: null,
          kind:
            u.speakerId && live.state.entities[u.speakerId]?.kind === 'player'
              ? 'speech'
              : 'npc_reply',
          channel: 'say', // Legacy storage has no channel; UI must suppress its badge.
          authorId: u.speakerId,
          authorLabel: view.entities.find((e) => e.id === u.speakerId)?.label,
          text: u.text,
          code: u.code,
          legacy: true,
        });
      }
      for (const n of view.npcNotices ?? [])
        legacy.push({
          id: `legacy-notice:${n.id}`,
          sequence: null,
          ordinal: 0,
          tick: n.tick,
          createdAt: null,
          kind: 'outcome',
          channel: 'say',
          authorId: n.npcId,
          authorLabel: view.entities.find((e) => e.id === n.npcId)?.label,
          code: n.kind,
          legacy: true,
        });
      // The previous normal story view exposed up to 64 committed public
      // turns. Preserve those durable inputs/results, not just the hot last 16.
      const oldNarrative = await this.db.query(
        "SELECT id,actor_id,input_text,result,created_at,committed_at FROM game_narrative_turns WHERE campaign_id=$1 AND status='committed' ORDER BY created_at DESC,id DESC LIMIT 64",
        [id],
      );
      for (const t of oldNarrative.reverse()) {
        if (turnIds.has(t.id)) continue;
        turnIds.add(t.id);
        const tick = Number.isSafeInteger(t.result?.tick) ? t.result.tick : 0;
        const common = {
          turnId: t.id,
          sequence: null,
          tick,
          createdAt: date(t.committed_at ?? t.created_at),
          channel: 'say' as const,
          legacy: true,
        };
        if (typeof t.input_text === 'string' && t.input_text)
          legacy.push({
            ...common,
            id: `legacy-narrative-input:${t.id}`,
            ordinal: 0,
            kind: 'speech',
            authorId: t.actor_id,
            authorLabel: view.entities.find((e) => e.id === t.actor_id)?.label,
            text: t.input_text,
          });
        if (typeof t.result?.narration === 'string' && t.result.narration)
          legacy.push({
            ...common,
            id: `legacy-narrative:${t.id}`,
            ordinal: 1,
            kind: 'narration',
            text: t.result.narration,
          });
      }
      for (const t of view.narrative?.turns ?? [])
        if (!turnIds.has(t.id))
          legacy.push({
            id: `legacy-narrative:${t.id}`,
            turnId: t.id,
            sequence: null,
            ordinal: 0,
            tick: t.tick,
            createdAt: null,
            kind: 'narration',
            channel: 'say',
            text: t.narration,
            legacy: true,
          });
      const all = [...legacy, ...entries]
        .sort(
          (x, y) =>
            x.tick - y.tick ||
            (x.sequence ?? -1) - (y.sequence ?? -1) ||
            (x.legacy && y.legacy
              ? (x.createdAt ?? '').localeCompare(y.createdAt ?? '') ||
                (x.turnId ?? x.id).localeCompare(y.turnId ?? y.id)
              : 0) ||
            x.ordinal - y.ordinal ||
            x.id.localeCompare(y.id),
        )
        .slice(-300);
      const turns = await this.db.query(
        `SELECT t.*,j.status AS job_status,j.credits AS job_credits FROM game_story_turns t LEFT JOIN game_npc_decision_requests r ON r.id=t.decision_request_id LEFT JOIN npc_ai_jobs j ON j.id=r.job_id WHERE t.campaign_id=$1 AND t.requester_user_id=$2 AND t.erased_at IS NULL AND t.status<>'quoted' ORDER BY t.created_at DESC LIMIT 40`,
        [id, a.user.id],
      );
      return {
        canonRevision: live.state.narrativeCanon?.revision ?? 0,
        canSubmit:
          live.state.rulesetVersion === 'hybrid-v3' &&
          (!live.state.turnController ||
            (live.state.turnController.phase === 'player' &&
              live.state.turnController.activeActorId === a.actorId &&
              !live.state.turnController.pendingResolution)),
        unavailableReason:
          live.state.rulesetVersion === 'hybrid-v3' ? null : 'NARRATIVE_RULESET_REQUIRED',
        configuration: live.state.turnController
          ? {
              provider: 'local-turn-resolver',
              enabled: true,
              externalCallsEnabled: false,
              demo: true,
              creditPrice: 0,
              providerUpperMicros: 0,
            }
          : this.ai.configuration(),
        entries: all,
        turns: turns.reverse().map((r) => this.receipt(r)),
      };
    });
  }
}

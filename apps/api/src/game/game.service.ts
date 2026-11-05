import { listCampaigns } from './campaign-list';
import { restorePublicNpcPresentation } from './public-npc-profile';
import { LocationTravelGeneration } from './location-travel-generation';
import { previewPendingStorySpeech } from './pending-story-speech';
import { isActorConscious } from '@dreamwalk/contracts';
import { forecastWorldRound } from './round-cost-forecast';
import { stampNpcThoughtAudience, projectNpcInnerThought } from './npc-thought-access';
import {
  campaignDirectorUpdateSchema,
  directorProfileIdSchema,
} from '@dreamwalk/contracts/dist/director-style';
import { readDirectorCatalog, directorProfile, transactionQueries } from '../ai/director-style';
import { WorldGenerationBatch } from './world-generation-batch';
import { NarrativeCorrections } from './narrative-corrections';
import { npcPublicReplySchema, footprintDistance } from '@dreamwalk/contracts';
import { StoryTurnRuntime } from './story-turn-runtime';
import { resolveReplyLocale } from './reply-locale';
import { mediaPreparationSchema, prepareSceneMedia } from './media-preparation';
import { readOwnedHero, pinHero, dressHero } from './hero-selection';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { config } from '../config';
import { AssetReuseService } from '../assets/reuse.service';
import { ImageGenerationService } from '../image-generation/service';
import { semanticGameProjection } from './projection-clock';
import { pruneNpcMemory } from './npc-retention';
import { recordNpcMetric } from './npc-telemetry';
import { extendContextHistory, reuseFrozenContext } from './context-history';
import { Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import {
  turnFenceSchema,
  localeSchema,
  type Locale,
  type TurnFence,
  gameActionSchema,
  gameHeroSelectionSchema,
  gameIntentSchema,
  gameMoveSchema,
  npcSpeechSchema,
  npcPlanProposalSchema,
  type GameState,
  type GameResult,
  type GameProjection,
} from '@dreamwalk/contracts';
import {
  initializeTurnController,
  registerTurnParticipant,
  removeTurnParticipant,
  applyTurnAction,
  applyTurnMove,
  endPlayerTurn,
  resolveTurnReaction,
  queueTurnSpeech,
  markTurnSpeechResolved,
  finishWorldPhase,
  applyWorldTurnAction,
  admitWorldTurnActors,
  worldTurnCompanionContinuation,
  companionAction,
  stepWorldNpcPlan,
  turnFence,
  matchesTurnFence,
  createStateFromPlayable,
  compilePlayableDraft,
  createCompleteObservatoryDraft,
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
  selectNpcSpeechObservationIds,
  admittedNpcSpeechObservationId,
  npcReplyObservation,
  commitNpcPublicUtterance,
  npcSpeechListenerIds,
  npcRoleplayObserverIds,
  npcSpeechProspectiveListenerIds,
  npcContextFingerprint,
  recordNpcEvents,
  recordNpcCognition,
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
import type { ReadyDecision, AiPurpose, DecisionContext } from '../ai/types';
import { insertNpcRequest, type NpcDecisionRequest } from './npc-requests';
import { archiveNpcEpisodes, recallNpcEpisodes } from './npc-memory';
import { Auth } from '../auth';
import { ApiException, fail } from '../errors';
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
      'turn.end',
      'turn.reaction',
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
    decision: z.enum(['accept', 'decline', 'defend']).optional(),
    turnFence: turnFenceSchema.optional(),
    intent: gameIntentSchema.optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
    ordinaryGeneration: z.boolean().optional(),
  })
  .strict();
export const moveSchema = gameMoveSchema
  .extend({
    connectionEpoch: z.number().int(),
    operationId: z.uuid().optional(),
    turnFence: turnFenceSchema.optional(),
  })
  .strict();
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
/** RP prose uses the same complete-audience authorization as ordinary claims. */
function safeRoleplayExtras(source: DecisionContext, current: DecisionContext) {
  const claims = Array.isArray(current.claims) ? (current.claims as Record<string, unknown>[]) : [];
  const roleplay = Array.isArray(source.untrustedRoleplay)
    ? source.untrustedRoleplay.filter((value: unknown) => {
        if (!value || typeof value !== 'object') return false;
        const entry = value as Record<string, unknown>;
        return claims.some(
          (claim) =>
            claim.kind === 'attempted' &&
            claim.actorId === entry.actorId &&
            claim.untrustedAttempt === entry.text &&
            (entry.observationId === undefined || claim.observationId === entry.observationId),
        );
      })
    : [];
  return roleplay.length
    ? { untrustedRoleplay: roleplay, roleplayPolicy: source.roleplayPolicy }
    : {};
}
export function roleplayExtrasRemainSafe(source: DecisionContext, current: DecisionContext) {
  return (
    digest(source.untrustedRoleplay ?? []) ===
    digest(safeRoleplayExtras(source, current).untrustedRoleplay ?? [])
  );
}
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
  private story: StoryTurnRuntime;
  private worldGeneration: WorldGenerationBatch;
  private corrections: NarrativeCorrections<Live>;
  private queues = new Map<string, Promise<unknown>>();
  // COMMIT visibility precedes the continuation that publishes its in-memory checkpoint.
  private publications = new Map<string, Promise<void>>();
  private pending = new Map<string, number>();
  private scheduledAdvances = new Set<string>();
  private ordinaryAdmissions = new Set<string>();
  private ordinaryAdmissionChecks = new Map<string, number>();
  private listeners = new Set<(campaignId: string) => void>();
  private npcJobs = new Set<string>();
  private npcTimers = new Set<ReturnType<typeof setTimeout>>();
  private npcCooldown = new Map<string, number>();
  private projections = new Map<string, { hash: string; revision: number }>();
  private timer: ReturnType<typeof setInterval>;
  private unavailableArt = new Set<string>();
  private artCheckedAt = new Map<string, number>();
  private travelGeneration?: LocationTravelGeneration;
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
    this.corrections = new NarrativeCorrections(this.db, {
      access: (req, id) => this.access(req, id),
      serial: <T>(id: string, work: () => Promise<T>) => this.serial(id, work),
      load: (id) => this.load(id),
      persist: (id, live, state, extra, preflight) =>
        this.persist(
          id,
          live,
          state,
          'narrative.preferences.updated',
          undefined,
          extra,
          undefined,
          preflight,
        ),
    });
    if (images) this.travelGeneration = new LocationTravelGeneration(this.db, images, this.art);
    this.worldGeneration = new WorldGenerationBatch(this.db, this.ai, this.travelGeneration);
    this.story = new StoryTurnRuntime(this.db, this.ai, {
      serial: <T>(id: string, work: () => Promise<T>) => this.serial(id, work),
      access: (req, id) => this.access(req, id),
      load: (id) => this.load(id),
      touch: (id, live, actorId) => this.touch(id, live as Live, actorId),
      persist: (id, live, state, kind, extra, preflight, prepare) =>
        this.persist(id, live as Live, state, kind, undefined, extra, prepare, preflight),
      canUseFrozenTravel: (id, turnId) =>
        this.travelGeneration?.canUseFrozen(id, turnId) ?? Promise.resolve(false),
      rebaseTravel: (id, turnId, state, input, proposal) =>
        this.travelGeneration?.rebase(id, turnId, state, input, proposal) ?? Promise.resolve(null),
      admitTravel: (id, turnId, proposal) =>
        this.travelGeneration
          ? this.travelGeneration.admitted(id, turnId, proposal)
          : Promise.reject(new Error('LOCATION_MEDIA_UNAVAILABLE')),
      dispatch: (id) => this.dispatchAi(id),
      failWorldRequest: (id, requestId, code) =>
        this.worldGeneration.failUnspent(id, requestId, code),
      deferredSpeechContext: (state, request) => this.deferredSpeechContext(state, request),
      prepareAreaTurnSpeech: (state, actorId, speech, userId, identity, targetNpcId) =>
        this.prepareAreaTurnSpeech(state, actorId, speech, userId, identity, targetNpcId),
      prepareTurnSpeech: (state, actorId, npcId, speech, requestId, userId, identity) =>
        this.prepareTurnSpeech(state, actorId, npcId, speech, requestId, userId, identity),
    });
    this.art.attachRuntimeStateReader((id) => this.live.get(id)?.state);
    this.ai.attachRuntimeStateReader?.(
      (id) => this.live.get(id)?.state,
      (id) => this.live.get(id)?.dbRevision,
    );
    images?.attachRuntimeStateReader((id) => {
      const cached = this.live.get(id);
      return cached ? { state: cached.state, dbRevision: cached.dbRevision } : undefined;
    });
    this.timer = setInterval(() => {
      for (const id of this.live.keys()) {
        // Polling and heartbeats can keep the request queue nonempty indefinitely.
        // Join that same FIFO rather than requiring an idle gap, but never queue
        // more than one world step per campaign or catch up wall-clock ticks.
        if (this.scheduledAdvances.has(id)) continue;
        this.scheduledAdvances.add(id);
        void this.serial(id, () => this.advance(id))
          .catch(() => {
            /* Database failure freezes durable mutation; next tick retries. */
          })
          .finally(() => {
            this.scheduledAdvances.delete(id);
            // Outside the campaign serial lock: native map-token preflight must
            // release it before its bounded, non-generating count operation.
            void this.admitOrdinaryRound(id);
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
      `SELECT c.*,s.checksum,s.state AS snapshot_state,COALESCE(v.package->'compiled'->>'title',v.package->'source'->>'title') AS game_title,v.source_revision,v.package AS source_package,v.checksum AS source_checksum FROM game_campaigns c JOIN game_snapshots s ON s.campaign_id=c.id LEFT JOIN game_playable_versions v ON v.id=c.source_version_id WHERE c.id=$1 AND c.status='active' AND EXISTS(SELECT 1 FROM users owner WHERE owner.id=c.owner_id AND owner.deleted_at IS NULL) AND ${sourceLiveSql()}`,
      [id],
    );
    const row = rows[0];
    if (!row) fail(404, 'NOT_FOUND', 'NOT_FOUND');
    if (digest(row.snapshot_state) !== row.checksum || digest(row.state) !== row.checksum)
      fail(503, 'RECOVERY_REQUIRED', 'RECOVERY_REQUIRED');
    let state = row.state as GameState;
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

    // Only the checksum-verified pinned author source can restore public presentation.
    // Never infer it from private memory biography or a mutable authoring record.
    if (
      row.source_version_id &&
      row.source_package &&
      digest(canonical(row.source_package)) === row.source_checksum
    )
      state = restorePublicNpcPresentation(state, row.source_package);

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
  async directors() {
    const catalog = await readDirectorCatalog(this.db);
    return { ...catalog, profiles: catalog.profiles.filter((profile) => profile.enabled) };
  }
  async director(req: Request, id: string, body?: unknown) {
    const input = body === undefined ? undefined : campaignDirectorUpdateSchema.parse(body);
    return this.serial(id, async () => {
      const access = await this.access(req, id);
      return this.db.tx(async (c) => {
        if (input) {
          if (access.user.id !== access.ownerId) fail(403, 'FORBIDDEN', 'FORBIDDEN');
          // Account/source locks precede campaign locks, matching erasure and preference updates.
          await c.query(
            `SELECT u.id FROM users u WHERE u.id=$2 OR u.id IN (SELECT m.user_id FROM game_members m WHERE m.campaign_id=$1) OR u.id IN (SELECT a.owner_id FROM game_campaigns c JOIN game_playable_versions v ON v.id=c.source_version_id JOIN adventures a ON a.id=v.adventure_id WHERE c.id=$1) ORDER BY u.id FOR SHARE OF u`,
            [id, access.user.id],
          );
          await c.query(
            'SELECT a.id FROM game_campaigns c JOIN game_playable_versions v ON v.id=c.source_version_id JOIN adventures a ON a.id=v.adventure_id WHERE c.id=$1 FOR SHARE OF a',
            [id],
          );
          await c.query(
            "SELECT i.id FROM game_campaigns c JOIN game_playable_versions v ON v.id=c.source_version_id JOIN adventure_invitations i ON i.adventure_id=v.adventure_id WHERE c.id=$1 AND i.recipient_id=$2 AND i.status='accepted' FOR SHARE OF i",
            [id, access.user.id],
          );
        }
        const row = (
          await c.query(
            `SELECT c.director_profile_id,c.director_revision,c.owner_id FROM game_campaigns c JOIN game_members m ON m.campaign_id=c.id JOIN users u ON u.id=m.user_id WHERE c.id=$1 AND m.user_id=$2 AND m.status='accepted' AND u.deleted_at IS NULL AND c.status='active' AND ${sourceAccessSql('$2')} ${input ? 'FOR UPDATE OF c' : ''}`,
            [id, access.user.id],
          )
        ).rows[0];
        if (!row || (input && row.owner_id !== access.user.id)) fail(403, 'FORBIDDEN', 'FORBIDDEN');
        const catalog = await readDirectorCatalog(transactionQueries(c));
        if (input && row.director_profile_id !== input.profileId) {
          if (Number(row.director_revision) !== input.expectedRevision)
            fail(409, 'DIRECTOR_STYLE_STALE', 'DIRECTOR_STYLE_STALE');
          directorProfile(catalog, input.profileId, true);
          row.director_profile_id = input.profileId;
          row.director_revision = Number(row.director_revision) + 1;
          await c.query(
            'UPDATE game_campaigns SET director_profile_id=$2,director_revision=$3 WHERE id=$1',
            [id, input.profileId, row.director_revision],
          );
        }
        return {
          profileId: row.director_profile_id,
          revision: Number(row.director_revision),
          profile: directorProfile(catalog, row.director_profile_id),
          canChange: row.owner_id === access.user.id,
        };
      });
    });
  }
  narrativePreferences(req: Request, id: string, body?: unknown) {
    return this.corrections.preferences(req, id, body);
  }
  storyFeed(req: Request, id: string) {
    return this.story.feed(req, id);
  }
  withRuntimeVisionQuote<T>(work: () => Promise<T>) {
    return this.ai.withRuntimeVisionQuote(work);
  }
  storyQuote(req: Request, id: string, body: unknown) {
    return this.story.quote(req, id, body);
  }
  npcInnerThought(req: Request, id: string, npcId: string) {
    z.string()
      .min(1)
      .max(100)
      .regex(/^[\w-]+$/)
      .refine((value) => !(value in Object.prototype))
      .parse(npcId);
    return this.serial(id, async () => {
      const access = await this.access(req, id),
        live = await this.load(id);
      const authored = await this.db.query(
        `SELECT 1 FROM game_campaigns c
         LEFT JOIN game_playable_versions v ON v.id=c.source_version_id
         LEFT JOIN adventures a ON a.id=v.adventure_id
         WHERE c.id=$1 AND ((c.source_version_id IS NULL AND c.owner_id=$2) OR a.owner_id=$2)`,
        [id, access.user.id],
      );
      return projectNpcInnerThought(live.state, access.actorId, npcId, authored.length > 0);
    });
  }
  worldGenerationStatus(req: Request, id: string) {
    return this.serial(id, async () => {
      const a = await this.access(req, id),
        live = await this.load(id);
      const status = await this.worldGeneration.status(a.user.id, id, live.state);
      // Owner authorization above precedes private context inspection. Reading
      // this forecast must not schedule, preflight, quote, or settle a request.
      const forecast =
        status.pending || status.unknown || !live.state.turnController
          ? null
          : await forecastWorldRound(this.db, this.ai, id, live.state, (state, request) =>
              this.deferredSpeechContext(state, request),
            );
      const ordinary =
        (
          await this.db.query(
            `SELECT state,result_code AS code FROM game_ordinary_round_consents
         WHERE campaign_id=$1 AND owner_id=$2 ORDER BY created_at DESC LIMIT 1`,
            [id, a.user.id],
          )
        )[0] ?? null;
      return { ...status, forecast, ordinary };
    });
  }
  worldGenerationQuote(req: Request, id: string, body: unknown) {
    return this.serial(id, async () => {
      const a = await this.access(req, id),
        live = await this.load(id);
      await this.scheduleRoundRequests(id, live);
      // Do not freeze a future map while earlier admitted narration can still change canon.
      const progress = await this.worldGeneration.status(a.user.id, id, live.state);
      if (progress.pending || progress.unknown)
        fail(409, 'LIVE_OUTCOME_UNRESOLVED', 'LIVE_OUTCOME_UNRESOLVED');
      // A semantic continuation can be staged after the original round roster was frozen.
      await this.story.prepareWorldRequests(id, live);
      await this.travelGeneration?.prepare(a.user.id, id, live.state);
      return this.worldGeneration.quote(a.user.id, id, live.state, body);
    });
  }
  worldGenerationConsent(req: Request, id: string, body: unknown) {
    return this.serial(id, async () => {
      const a = await this.access(req, id),
        live = await this.load(id);
      const receipt = await this.worldGeneration.consent(a.user.id, id, live.state, body);
      live.decisionsPending = true;
      return receipt;
    });
  }
  worldGenerationDecline(req: Request, id: string, body: unknown) {
    return this.serial(id, async () => {
      const a = await this.access(req, id),
        live = await this.load(id);
      const result = await this.worldGeneration.declineLocations(a.user.id, id, live.state, body);
      this.ordinaryAdmissionChecks.delete(id);
      live.decisionsPending = true;
      return result;
    });
  }
  storyReplyQuote(req: Request, id: string, turnId: string, body: unknown) {
    return this.story.replyQuote(req, id, turnId, body);
  }
  storyReplyConsent(req: Request, id: string, turnId: string, body: unknown) {
    return this.story.replyConsent(req, id, turnId, body);
  }
  storySubmit(req: Request, id: string, body: unknown) {
    return this.story.submit(req, id, body);
  }
  storyConfirm(req: Request, id: string, turnId: string, body: unknown) {
    return this.story.confirm(req, id, turnId, body);
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
      allowedActions: [
        'open',
        'close',
        'inspect',
        'pick_up',
        'consume',
        'knock',
        'wait',
        'give',
        ...(state.turnController ? ['hit', 'push'] : []),
      ],
      ...(state.turnController ? { turnFence: turnFence(state) } : {}),
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
      if (live.state.turnController) fail(409, 'USE_UNIFIED_TURN', 'USE_UNIFIED_TURN');
      if (live.state.rulesetVersion !== 'hybrid-v3')
        fail(409, 'NARRATIVE_RULESET_REQUIRED', 'NARRATIVE_RULESET_REQUIRED');
      const input = z
        .object({
          text: z.string().trim().min(1).max(1000),
          expectedCanonRevision: z.number().int().nonnegative(),
          audience: z.literal('shared').default('shared'),
          replyLocale: localeSchema.optional(),
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
      const replyLocale = resolveReplyLocale(req, input.replyLocale, a.user.settings.language);
      const base = await extendContextHistory(
        this.db,
        this.ai,
        id,
        live.state,
        a.actorId,
        buildNarrativeContext(live.state, a.actorId, input.text, replyLocale),
        'narrative',
      );
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
          mockProposal: createMockNarrativeProposal(
            live.state,
            a.actorId,
            input.text,
            turnId,
            replyLocale,
          ),
        };
      if (
        (!this.ai.contextWindow() &&
          Buffer.byteLength(JSON.stringify(context)) > this.ai.contextBudgetBytes()) ||
        !this.ai.contextFits('narrative', context)
      )
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
        replyLocale: localeSchema.optional(),
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
      if (live.state.turnController) fail(409, 'TURN_WORLD_ONLY', 'TURN_WORLD_ONLY');
      if (live.state.rulesetVersion !== 'hybrid-v3' || !live.state.npcBrains?.[input.npcId]?.living)
        fail(404, 'NOT_FOUND', 'NOT_FOUND');
      const scope = {
        campaignId: id,
        npcId: input.npcId,
        origin: 'user' as const,
        purpose: input.purpose,
        requesterUserId: a.user.id,
      };
      const replyLocale = resolveReplyLocale(req, input.replyLocale, a.user.settings.language);
      const requestKey =
        input.purpose === 'speech'
          ? `${input.channel}:${a.actorId}:${input.topicId ?? ''}:${replyLocale}`
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
              undefined,
              undefined,
              replyLocale,
            )
          : await this.decisionContext(id, live.state, input.npcId, input.purpose);
      const context = await extendContextHistory(
        this.db,
        this.ai,
        id,
        live.state,
        a.actorId,
        {
          ...base,
          mockProposal:
            input.purpose === 'speech'
              ? createMockNpcPublicResponse(base as ReturnType<typeof buildNpcPublicSpeechContext>)
              : input.purpose === 'summary'
                ? createNpcMemorySummary(live.state, input.npcId)
                : createMockNpcPlan(live.state, input.npcId),
        },
        input.purpose,
        input.npcId,
      );
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
    const raw = buildNpcDecisionContext(state, npcId);
    const base = { ...raw, ...(state.turnController ? { turnFence: turnFence(state) } : {}) };
    if (this.ai.contextWindow())
      return extendContextHistory(
        this.db,
        this.ai,
        id,
        state,
        npcId,
        base,
        purpose as AiPurpose,
        npcId,
      );
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
    deferredSpeechId?: string,
    replyLocale?: Locale,
  ) {
    const npc = state.entities[npcId],
      recipient = state.entities[recipientId];
    const deferred =
      deferredSpeechId && state.turnController?.phase === 'world'
        ? state.turnController.deferredSpeech.find(
            (item) =>
              item.id === deferredSpeechId &&
              item.actorId === recipientId &&
              item.recipientId === npcId &&
              item.utteranceId === replyToObservationId &&
              item.channel === channel,
          )
        : undefined;
    if (deferredSpeechId && !deferred) fail(409, 'STALE_STATE', 'STALE_STATE');
    if (
      !npc ||
      !isActorConscious(npc) ||
      !recipient ||
      !isActorConscious(recipient) ||
      (!deferred && (npc.mapId !== recipient.mapId || footprintDistance(npc, recipient) > 1)) ||
      npc.encounterId ||
      recipient.encounterId
    )
      fail(409, 'OUT_OF_RANGE', 'OUT_OF_RANGE');
    const audience = npcSpeechProspectiveListenerIds(state, npcId, channel);
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
      selectNpcSpeechObservationIds(
        state,
        npcId,
        audience,
        replyToObservationId ? [replyToObservationId] : [],
        requestedFactIds,
      );
    const publicContext = buildNpcPublicSpeechContext(
      state,
      npcId,
      audience,
      observations,
      requestedFactIds,
      deferredSpeechId,
      replyLocale,
      recipientId,
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
      ...(deferredSpeechId ? { deferredSpeechId } : {}),
    };
    return packNpcContext(
      { ...safe, ...(state.turnController ? { turnFence: turnFence(state) } : {}) },
      this.ai.contextBudgetBytes(),
    );
  }
  private dispatchAi(id: string) {
    // Network/provider work must never occupy the campaign writer or a DB transaction.
    void this.ai
      .runNext(id, async () => {
        const live = this.live.get(id);
        if (
          !live ||
          live.paused ||
          (live.state.turnController && live.state.turnController.phase !== 'world') ||
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
    let cognitionCommitted = false;
    let decisionCode: string | undefined;
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
    if (
      state.turnController &&
      (!job.context.turnFence ||
        !matchesTurnFence(state, job.context.turnFence as TurnFence) ||
        state.turnController.phase !== 'world')
    )
      return { next, accepted, intentOutcome, narrativeOutcome, decisionCode };
    const memory = state.npcBrains?.[job.npcId]?.living;
    if (
      memory &&
      (!isActorConscious(state.entities[job.npcId]) ||
        Number(job.context.lifeRevision ?? 0) !== (state.entities[job.npcId].lifeRevision ?? 0))
    )
      return {
        next,
        accepted,
        intentOutcome,
        narrativeOutcome,
        decisionCode: 'NPC_LIFECYCLE_CHANGED',
      };
    if (job.purpose === 'narrative') {
      const metadata = z
        .object({
          turnId: z.uuid(),
          intent: z.string().min(1).max(1000),
          replyLocale: localeSchema.optional(),
        })
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
            metadata.data.replyLocale,
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
          deferredSpeechId: z.uuid().optional(),
          replyLocale: localeSchema.optional(),
        })
        .passthrough()
        .safeParse(job.context);
      const proposal = npcPublicReplySchema.safeParse(job.proposal);
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
            request.data.deferredSpeechId,
            request.data.replyLocale,
          );
        } catch {
          /* No longer nearby/in same phase: stale, never broadcast. */
        }
        if (
          context &&
          roleplayExtrasRemainSafe(job.context, context) &&
          (context.contextHash === job.contextHash ||
            this.frozenSpeechContext(state, job.npcId, job.context, context))
        ) {
          const keepPrivateCognition =
            !!memory.cognition &&
            (!memory.cognition.sourceObservationId ||
              (!!state.turnController &&
                memory.cognition.roundId === state.turnController.roundId));
          if ('silent' in proposal.data && proposal.data.silent) {
            accepted = job.context.responseOptional === true;
            if (accepted && proposal.data.cognition && !keepPrivateCognition) {
              const thought = recordNpcCognition(state, job.npcId, proposal.data.cognition, {
                knowledgeRevision: memory.knowledgeRevision,
                turnFence: turnFence(state) ?? undefined,
                sourceObservationId: request.data.replyToObservationId,
              });
              if (!thought.error) {
                next = thought.state;
                cognitionCommitted = true;
              }
            }
          } else {
            const result = commitNpcPublicUtterance(state, job.npcId, {
              ...proposal.data,
              ...(keepPrivateCognition ? { cognition: undefined } : {}),
              channel: context.channel,
              recipientId: context.recipientId,
              observationIds: context.observationIds,
              requestedFactIds: context.requestedFactIds,
              contextHash: context.speechHash,
              replyToObservationId: request.data.replyToObservationId,
              replyLocale: request.data.replyLocale,
              ...(request.data.deferredSpeechId
                ? { deferredSpeechId: request.data.deferredSpeechId }
                : {}),
            });
            if (!result.error) {
              cognitionCommitted =
                'cognition' in proposal.data && !!proposal.data.cognition && !keepPrivateCognition;
              next = recordNpcEvents(state, result.state, result.events, 'ai-' + job.id).state;
              if (state.turnController) {
                next = structuredClone(next);
                next.tick++;
                next.revision++;
              }
              accepted = true;
            }
          }
        }
      }
    } else if (
      memory &&
      (this.frozenRoundContext(state, job.npcId, job.context) ||
        (await this.decisionContext(id, state, job.npcId, job.purpose)).contextHash ===
          job.contextHash)
    ) {
      if (job.purpose === 'plan') {
        let result = acceptNpcPlan(state, job.npcId, job.proposal);
        if (result.error && this.frozenRoundContext(state, job.npcId, job.context)) {
          const proposal = npcPlanProposalSchema.safeParse(job.proposal);
          if (proposal.success && proposal.data.turnFence) {
            // The model completed a valid deliberation; an impossible or forbidden
            // intention is an in-world blocked outcome, not an unknown provider bill.
            // Re-run the SAME core envelope/cognition checks with no executable intent.
            // Stale actor/map/brain/round/deadline and malformed proposals still fail.
            const blocked = result.error;
            const considered = acceptNpcPlan(state, job.npcId, {
              ...proposal.data,
              actions: [{ kind: 'wait' }],
              targetRevisions: {},
              beliefRevisions: undefined,
            });
            if (!considered.error) {
              const brain = considered.state.npcBrains![job.npcId];
              brain.plan = [];
              brain.cursor = 0;
              brain.living!.lastActionOutcome = {
                actionKind: proposal.data.actions[0]?.kind ?? 'wait',
                status: 'blocked',
                code: blocked,
                tick: state.tick,
                roundId: state.turnController!.roundId,
              };
              result = considered;
              decisionCode = `NPC_INTENTION_BLOCKED:${blocked}`;
            }
          }
        }
        if (!result.error) {
          cognitionCommitted = !!(job.proposal as { cognition?: unknown } | null)?.cognition;
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
    if (accepted && cognitionCommitted)
      next = stampNpcThoughtAudience(next, job.npcId, job.purpose, job.context);
    if (!accepted)
      recordNpcMetric(job.purpose === 'summary' ? 'summaryRejected' : 'knowledgeRejected');
    if (state.turnController && typeof job.context.deferredSpeechId === 'string') {
      const resolved = markTurnSpeechResolved(next, job.context.deferredSpeechId, turnFence(next)!);
      if (!resolved.error) next = resolved.state;
    }
    return { next, accepted, intentOutcome, narrativeOutcome, decisionCode };
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
  /** Freeze the complete active-scene roster before any world result can commit. */
  private async scheduleRoundRequests(id: string, live: Live) {
    let state = live.state;
    const turn = state.turnController;
    if (!turn || turn.phase !== 'world') return;
    const frozenRoster = await this.db.query(
      'SELECT 1 FROM game_world_round_rosters WHERE campaign_id=$1 AND round_id=$2',
      [id, turn.roundId],
    );
    if (frozenRoster.length) return;
    const maps = new Set(turn.actorOrder.map((actor) => state.entities[actor]?.mapId));
    const roster = Object.entries(state.npcBrains ?? {})
      .filter(([npcId, brain]) => {
        const npc = state.entities[npcId];
        return (
          !!brain.living &&
          npc?.kind === 'npc' &&
          !npc.encounterId &&
          isActorConscious(npc) &&
          (maps.has(npc.mapId) || !!worldTurnCompanionContinuation(state, npcId))
        );
      })
      .sort(([a], [b]) => a.localeCompare(b));
    const admitted = admitWorldTurnActors(
      state,
      roster.map(([npcId]) => npcId),
      turnFence(state)!,
    );
    if (admitted.error) fail(409, admitted.error, admitted.error);
    state = admitted.state;
    await this.story.prepareWorldRequests(id, { ...live, state });
    const existing = await this.db.query(
      "SELECT npc_id,purpose,cause_key,context FROM game_npc_decision_requests WHERE campaign_id=$1 AND (context->'turnFence'->>'roundId'=$2 OR cause_key LIKE $3)",
      [id, turn.roundId, `round:${turn.roundId}:%`],
    );
    const requests: NpcDecisionRequest[] = [];
    const continuing: string[] = [];
    const offmapCompanions = new Set<string>();
    for (const [npcId, brain] of roster) {
      if (existing.some((r) => r.npc_id === npcId && r.purpose === 'plan')) continue;
      const npc = state.entities[npcId];
      const causeKey = `round:${turn.roundId}:${npcId}`;
      if (!maps.has(npc.mapId)) {
        const action = worldTurnCompanionContinuation(state, npcId);
        if (!action) continue;
        const requestId = randomUUID();
        requests.push({
          id: requestId,
          npcId,
          purpose: 'plan',
          causeKey,
          context: {
            contextHash: digest({ roundId: turn.roundId, npcId, action }),
            turnFence: turnFence(state),
            offmapCompanionContinuation: true,
          },
        });
        continuing.push(requestId);
        offmapCompanions.add(npcId);
        continue;
      }
      const context = await this.decisionContext(id, state, npcId, 'plan');
      // Every active-scene NPC deliberates once per player round, including empty
      // turns. Existing plans, obligations and thoughts are context, not permission
      // to silently skip this round's model decision. Off-map agreed crossings above
      // remain mechanical continuation and never wake dormant NPC minds.
      const requestId = randomUUID();
      requests.push({
        id: requestId,
        npcId,
        purpose: 'plan',
        causeKey,
        context: {
          ...context,
          worldRoundDecision: {
            ...turnFence(state),
            npcId,
            entityRevision: npc.revision,
            brainGeneration: brain.generation,
            mapId: npc.mapId,
            mapRevision: state.maps[npc.mapId].revision,
          },
          mockProposal: createMockNpcPlan(state, npcId),
        },
      });
    }
    await this.persist(id, live, state, 'npc.round.considered', undefined, async (c) => {
      await c.query(
        'INSERT INTO game_world_round_rosters(campaign_id,round_id,turn_fence,roster) VALUES($1,$2,$3,$4)',
        [
          id,
          turn.roundId,
          JSON.stringify(turnFence(state)),
          JSON.stringify(
            roster.map(([npcId]) => ({
              npcId,
              consideration: offmapCompanions.has(npcId) ? 'companion' : 'plan',
            })),
          ),
        ],
      );
      for (const request of requests) await insertNpcRequest(c, id, request);
      // Continuing an already admitted intention is a durable, free consideration.
      if (continuing.length)
        await c.query(
          "UPDATE game_npc_decision_requests SET status='fallback',result_code='ROUND_CONTINUE' WHERE id=ANY($1::uuid[]) AND status='queued'",
          [continuing],
        );
    });
    await this.worldGeneration.stopUnspentForUnknown(id);
    live.decisionsPending = true;
  }
  private frozenRoundContext(state: GameState, npcId: string, context: DecisionContext) {
    const frozen = context.worldRoundDecision as Record<string, unknown> | undefined;
    const npc = state.entities[npcId],
      brain = state.npcBrains?.[npcId];
    return (
      !!frozen &&
      state.turnController?.phase === 'world' &&
      matchesTurnFence(state, context.turnFence) &&
      matchesTurnFence(state, {
        roundId: frozen.roundId,
        phaseEpoch: frozen.phaseEpoch,
        rulesetVersion: frozen.rulesetVersion,
      }) &&
      frozen.npcId === npcId &&
      !!npc &&
      isActorConscious(npc) &&
      !!brain &&
      !npc.encounterId &&
      frozen.entityRevision === npc.revision &&
      frozen.brainGeneration === brain.generation &&
      frozen.mapId === npc.mapId &&
      frozen.mapRevision === state.maps[npc.mapId]?.revision
    );
  }
  private frozenSpeechContext(
    state: GameState,
    npcId: string,
    frozen: DecisionContext,
    current: DecisionContext,
  ) {
    if (
      frozen.generationPolicy !== 'world-batch-v1' ||
      !frozen.worldPrepared ||
      !matchesTurnFence(state, frozen.turnFence) ||
      state.turnController?.phase !== 'world'
    )
      return false;
    // The public response saw only these audience-authorized claims. Revalidate
    // them and current audience; core independently checks every action/item intent.
    // New unrelated observations/other NPC decisions cannot rewrite the paid body.
    return (
      frozen.npcId === npcId &&
      Number(frozen.lifeRevision ?? 0) === Number(current.lifeRevision ?? 0) &&
      current.npcId === npcId &&
      digest(frozen.claims) === digest(current.claims) &&
      digest(frozen.audienceIds) === digest(current.audienceIds) &&
      frozen.recipientId === current.recipientId &&
      frozen.channel === current.channel &&
      digest(frozen.publicIdentity ?? null) === digest(current.publicIdentity ?? null) &&
      digest(frozen.performance ?? null) === digest(current.performance ?? null) &&
      digest(frozen.currentPlace ?? null) === digest(current.currentPlace ?? null) &&
      digest(frozen.publicSpeechStyle ?? null) === digest(current.publicSpeechStyle ?? null) &&
      digest(frozen.requestedFactIds ?? []) === digest(current.requestedFactIds ?? [])
    );
  }
  private async scheduleAutonomousRequests(id: string, live: Live) {
    if (live.state.turnController) return this.scheduleRoundRequests(id, live);
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
      if (
        !b.living ||
        !isActorConscious(npc) ||
        b.living.companionship ||
        npc.encounterId ||
        b.cursor < b.plan.length ||
        npc.path?.length
      )
        continue;
      const previousCauses = await this.db.query(
        "SELECT cause_key,context FROM game_npc_decision_requests WHERE campaign_id=$1 AND npc_id=$2 AND purpose='plan'",
        [id, npcId],
      );
      if (
        live.state.turnController &&
        previousCauses.some(
          (row) => row.context?.turnFence?.roundId === live.state.turnController!.roundId,
        )
      )
        continue;
      const consumedCauses = new Set(previousCauses.map((row) => row.cause_key));
      const cause = b.living.causes
        .filter((c) => {
          const observation = b.living!.observations.find((o) => o.id === c.observationId);
          // A unified turn already pays for one combined decision. Its mechanical
          // evidence still drives deterministic goals, but never an extra AI job.
          const sameTurn =
            /^turn:[0-9a-f-]{36}:[0-5]:\d+$/i.test(observation?.eventId ?? '') ||
            /^turn:[0-9a-f-]{36}:[0-5]:\d+$/i.test(observation?.rootId ?? '');
          return (
            !consumedCauses.has(`cause:${c.id}`) &&
            c.priority >= 2 &&
            c.notBeforeTick <= live.state.tick &&
            (!sameTurn ||
              (live.state.turnController &&
                ['harmed', 'pushed'].includes(observation?.kind ?? ''))) &&
            ['item_taken', 'item_missing', 'claim', 'noise', 'harmed', 'pushed'].includes(
              observation?.kind ?? '',
            )
          );
        })
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
  private async failUnqueuedManualRequest(requestId: string, code: string) {
    return this.db.tx(async (c) => {
      const released = await this.ai.rejectManualUnqueuedRequest(c, requestId, code);
      if (released)
        await c.query(
          "UPDATE game_npc_decision_requests SET status='failed',result_code=$2 WHERE id=$1 AND status='queued'",
          [requestId, code],
        );
      else
        await c.query(
          "UPDATE game_npc_decision_requests SET result_code=$2 WHERE id=$1 AND status='queued'",
          [requestId, code],
        );
      return released;
    });
  }
  private async processDecisionRequests(id: string, live: Live) {
    if (live.state.turnController && live.state.turnController.phase !== 'world') return;
    await this.story.reconcileTerminalTravel(id);
    await this.reconcileIntents(id, live.state.tick);
    const requests = await this.db.query(
      "SELECT * FROM game_npc_decision_requests WHERE campaign_id=$1 AND status='queued' ORDER BY CASE WHEN purpose='plan' AND context ? 'worldRoundDecision' THEN 0 WHEN purpose='story_turn' AND context ? 'travelSceneSpec' THEN 1 WHEN purpose='story_turn' AND context->>'generationPolicy'='world-batch-v1' THEN 2 ELSE 3 END,CASE WHEN context ? 'turnOrder' THEN (context->>'turnOrder')::bigint ELSE 9223372036854775807 END,created_at,id LIMIT 8",
      [id],
    );
    for (let r of requests) {
      if (typeof r.context.awaitStoryDirector === 'string') {
        const director = await this.db.query(
          "SELECT status FROM game_npc_decision_requests WHERE campaign_id=$1 AND id=$2 AND purpose='story_turn'",
          [id, r.context.awaitStoryDirector],
        );
        if (!director.length || ['queued', 'scheduled'].includes(String(director[0].status)))
          continue;
        if (
          r.context.pendingStorySpeech &&
          !live.state.turnController?.deferredSpeech.some(
            (ref) => ref.id === r.id && !ref.pendingStoryTurnId,
          )
        ) {
          await this.worldGeneration.failUnspent(id, r.id, 'STORY_SPEECH_NOT_ADMITTED');
          continue;
        }
        if (
          r.context.pendingStorySpeech &&
          r.context.generationPolicy === 'world-batch-v1' &&
          Number(r.context.pendingStorySpeechKnowledgeRevision) !==
            live.state.npcBrains?.[r.npc_id]?.living?.knowledgeRevision
        ) {
          await this.worldGeneration.failUnspent(id, r.id, 'ROUND_CONTEXT_STALE');
          continue;
        }
      }
      const npc = live.state.entities[r.npc_id];
      if (
        npc?.kind === 'npc' &&
        (!isActorConscious(npc) || Number(r.context.lifeRevision ?? 0) !== (npc.lifeRevision ?? 0))
      ) {
        await this.worldGeneration.failUnspent(id, r.id, 'NPC_LIFECYCLE_CHANGED');
        continue;
      }
      if (r.purpose === 'speech' && r.context.deferredSpeechId) {
        // Preserve the player's chronological conversation across different NPCs.
        // A queued reply must not overtake an earlier scheduled/busy reply merely
        // because the later NPC has a free provider slot. Terminal refs drain in
        // advanceTurnWorld; private NPC planning remains independently eligible.
        const first = live.state.turnController?.deferredSpeech.reduce<
          { id: string; sequence: number } | undefined
        >(
          (earliest, entry) => (!earliest || entry.sequence < earliest.sequence ? entry : earliest),
          undefined,
        );
        if (first && first.id !== r.context.deferredSpeechId) continue;
      }
      const allowed = r.requester_user_id
        ? await this.db.query(
            `SELECT c.id FROM game_campaigns c JOIN game_members m ON m.campaign_id=c.id JOIN users u ON u.id=m.user_id WHERE c.id=$1 AND m.user_id=$2 AND m.status='accepted' AND u.deleted_at IS NULL AND ${sourceAccessSql('$2')}`,
            [id, r.requester_user_id],
          )
        : [{ id }];
      if (
        !allowed.length ||
        (r.purpose === 'intent' || r.purpose === 'narrative' || r.purpose === 'story_turn'
          ? live.state.entities[r.npc_id]?.kind !== 'player'
          : !live.state.npcBrains?.[r.npc_id])
      ) {
        await this.db.query(
          "UPDATE game_npc_decision_requests SET status='cancelled',context='{}',result_code='AUTHORIZATION_REVOKED' WHERE id=$1 AND status='queued'",
          [r.id],
        );
        continue;
      }
      if (
        live.state.turnController &&
        r.purpose !== 'story_turn' &&
        !(r.purpose === 'speech' && r.context.deferredSpeechId) &&
        !matchesTurnFence(live.state, r.context.turnFence)
      ) {
        await this.db.query(
          "UPDATE game_npc_decision_requests SET status='cancelled',result_code='TURN_PHASE_STALE' WHERE id=$1 AND status='queued'",
          [r.id],
        );
        continue;
      }
      if (
        r.result_code === 'GENERATION_QUOTE_STALE' ||
        (await this.story.requireLegacyReplyConsent(id, r))
      )
        continue;
      const storyReply = await this.story.quotedReply(id, r);
      const worldReply =
        !storyReply && this.ai.releaseGeneration()
          ? await this.worldGeneration.quotedWorldRequest(id, r)
          : null;
      const quotedReply = storyReply || worldReply;
      if (
        this.ai.releaseGeneration() &&
        (r.context.worldRoundDecision || r.context.generationPolicy === 'world-batch-v1') &&
        !quotedReply
      )
        continue;
      if (worldReply && (r.purpose === 'plan' || r.purpose === 'summary')) {
        const current = await this.decisionContext(id, live.state, String(r.npc_id), r.purpose);
        if (
          !this.frozenRoundContext(live.state, String(r.npc_id), r.context) &&
          current.contextHash !== r.context.contextHash
        ) {
          if (r.context.worldRoundDecision) {
            await this.worldGeneration.failUnspent(id, r.id, 'ROUND_CONTEXT_STALE');
            continue;
          }
          await this.worldGeneration.invalidate(id, r.id);
          // An unpaid stale batch never authorizes a new body. Prepare a fresh
          // candidate for a new visible quote, retaining the original paid evidence.
          await this.db.query(
            "UPDATE game_npc_decision_requests SET context=$2 WHERE id=$1 AND status='queued' AND job_id IS NULL",
            [
              r.id,
              JSON.stringify({
                ...current,
                mockProposal:
                  r.purpose === 'plan'
                    ? createMockNpcPlan(live.state, String(r.npc_id))
                    : r.context.mockProposal,
              }),
            ],
          );
          continue;
        }
      }
      if (live.state.turnController && r.purpose === 'speech' && r.context.deferredSpeechId) {
        try {
          const current = this.speechContext(
            live.state,
            String(r.npc_id),
            String(r.context.recipientId),
            r.context.channel,
            r.context.observationIds,
            r.context.topicId,
            r.context.replyToObservationId,
            r.context.deferredSpeechId,
            r.context.replyLocale,
          );
          if (
            quotedReply &&
            ((current.contextHash !== r.context.contextHash &&
              !this.frozenSpeechContext(live.state, String(r.npc_id), r.context, current)) ||
              !roleplayExtrasRemainSafe(r.context, current) ||
              !matchesTurnFence(live.state, r.context.turnFence))
          ) {
            if (worldReply && r.context.generationPolicy === 'world-batch-v1')
              await this.worldGeneration.failUnspent(id, r.id, 'ROUND_CONTEXT_STALE');
            else if (worldReply) await this.worldGeneration.invalidate(id, r.id);
            else
              await this.db.query(
                "UPDATE game_npc_decision_requests SET result_code='GENERATION_QUOTE_STALE' WHERE id=$1 AND status='queued'",
                [r.id],
              );
            continue;
          }
          const context = quotedReply
            ? r.context
            : reuseFrozenContext(
                r.context,
                {
                  ...current,
                  storyTurnId: r.context.storyTurnId,
                  segmentIndex: r.context.segmentIndex,
                  knowledgeRevision: r.context.knowledgeRevision,
                  lifeRevision: r.context.lifeRevision ?? 0,
                  ...(typeof r.context.awaitStoryDirector === 'string'
                    ? { awaitStoryDirector: r.context.awaitStoryDirector }
                    : {}),
                  ...(r.context.pendingStorySpeech
                    ? {
                        pendingStorySpeech: r.context.pendingStorySpeech,
                        pendingStorySpeechKnowledgeRevision:
                          r.context.pendingStorySpeechKnowledgeRevision,
                      }
                    : {}),
                  deferredSpeechId: r.context.deferredSpeechId,
                  turnOrder: r.context.turnOrder,
                  ...(r.context.responseOptional ? { responseOptional: true } : {}),
                  ...safeRoleplayExtras(r.context, current),
                  mockProposal: createMockNpcPublicResponse(current),
                },
                Boolean(this.ai.contextWindow()),
              );
          if (context !== r.context) {
            await this.db.query(
              "UPDATE game_npc_decision_requests SET context=$2 WHERE id=$1 AND status='queued'",
              [r.id, JSON.stringify(context)],
            );
            r = { ...r, context };
          }
        } catch {
          if (worldReply && r.context.generationPolicy === 'world-batch-v1')
            await this.worldGeneration.failUnspent(id, r.id, 'STALE_DEFERRED_SPEECH');
          else
            await this.db.query(
              "UPDATE game_npc_decision_requests SET status='failed',result_code='STALE_DEFERRED_SPEECH',context='{}' WHERE id=$1 AND status='queued'",
              [r.id],
            );
          continue;
        }
      }
      if (
        !quotedReply &&
        this.ai.contextWindow() &&
        r.purpose === 'speech' &&
        !r.context.historyPolicy
      ) {
        const extended = await extendContextHistory(
          this.db,
          this.ai,
          id,
          live.state,
          r.context.recipientId ?? String(r.npc_id),
          r.context,
          'speech',
          String(r.npc_id),
        );
        r.context = await this.db.tx(async (c) => {
          const locked = (
            await c.query(
              "SELECT context FROM game_npc_decision_requests WHERE id=$1 AND status='queued' FOR UPDATE",
              [r.id],
            )
          ).rows[0];
          if (!locked) return r.context;
          // A paid consent freezes the exact body. Never enrich/reprice an admitted request.
          const admitted = await c.query(
            "SELECT 1 FROM live_test_text_permits WHERE request_id=$1 AND state IN ('authorized','dispatched','settled','unknown') LIMIT 1",
            [r.id],
          );
          if (admitted.rowCount || locked.context.historyPolicy) return locked.context;
          await c.query('UPDATE game_npc_decision_requests SET context=$2 WHERE id=$1', [
            r.id,
            JSON.stringify(extended),
          ]);
          return extended;
        });
      }
      // A real/manual request never becomes a fixture response when authorization or provider work fails.
      if (this.ai.manualLive() && r.purpose !== 'story_turn' && !quotedReply) {
        if (r.context.budgetExceeded && this.ai.contextWindow() && r.context.textContextCandidate)
          continue;
        if (r.context.budgetExceeded) {
          await this.failUnqueuedManualRequest(String(r.id), 'CONTEXT_BUDGET_EXCEEDED');
          continue;
        }
        if (!(await this.ai.manualRequestAuthorized(String(r.id), r.context))) {
          await this.failUnqueuedManualRequest(String(r.id), 'MANUAL_AUTHORIZATION_UNAVAILABLE');
          continue;
        }
      }
      if (r.purpose === 'story_turn') {
        await this.story.schedule(id, live, r, worldReply);
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
          buildNarrativeContext(
            live.state,
            String(r.npc_id),
            String(turn.input_text),
            r.context.replyLocale,
          ).contextHash !== r.context.contextHash
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
      const sponsorId = quotedReply ? undefined : await this.ai.activeSponsor(id, purpose);
      const useProvider =
        configuration.enabled &&
        !busy &&
        !r.context.budgetExceeded &&
        ((configuration.provider === 'mock' && configuration.creditPrice === 0) ||
          this.ai.manualLive() ||
          Boolean(sponsorId));
      if (!useProvider && this.ai.manualLive()) {
        // An operator kill switch pauses queued speech/decisions; the original consent and hold remain intact.
        if (!configuration.enabled)
          await this.db.query(
            "UPDATE game_npc_decision_requests SET result_code='PROVIDER_DISABLED' WHERE id=$1 AND status='queued'",
            [r.id],
          );
        else await this.failUnqueuedManualRequest(String(r.id), 'MANUAL_PROVIDER_UNAVAILABLE');
        continue;
      }
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
          if (decision.accepted && purpose === 'speech' && r.context.deferredSpeechId)
            await this.story.writeDeferredReply(
              c,
              id,
              live.state,
              decision.next,
              r.context,
              live.eventSeq + 1,
            );
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
          ...(worldReply ? { acceptedWorldBatchId: worldReply.batchId } : {}),
          ...(quotedReply
            ? {
                quoteId: quotedReply.quote.id,
                consent: true,
                requesterUserId: String(r.requester_user_id),
                expectedRuntimeContextDigest: digest(r.context),
              }
            : {}),
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
        if (quotedReply) {
          if (
            worldReply &&
            (r.context.worldRoundDecision || r.context.generationPolicy === 'world-batch-v1')
          )
            await this.worldGeneration.failUnspent(
              id,
              r.id,
              /^[A-Z0-9_]{1,80}$/.test(message) ? message : 'WORLD_ADMISSION_FAILED',
            );
          else if (worldReply) await this.worldGeneration.invalidate(id, r.id);
          else
            await this.db.query(
              "UPDATE game_npc_decision_requests SET result_code='GENERATION_QUOTE_STALE' WHERE id=$1 AND status='queued'",
              [r.id],
            );
          continue;
        }
        if (this.ai.manualLive()) {
          const code = /^[A-Z0-9_]{1,80}$/.test(message) ? message : 'MANUAL_QUEUE_UNAVAILABLE';
          await this.failUnqueuedManualRequest(String(r.id), code);
          continue;
        }
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
  /** Cancel only undispatched/received work through the existing financial sweep.
   * Running calls settle normally; their eventual result fails the lifecycle fence. */
  private async cancelStaleNpcLifecycleJobs(id: string, state: GameState) {
    const npcs = Object.values(state.entities).filter((entity) => entity.kind === 'npc');
    const inactive = npcs.filter((entity) => !isActorConscious(entity)).map((entity) => entity.id);
    const changed = Object.fromEntries(
      npcs
        .filter((entity) => entity.lifeRevision)
        .map((entity) => [entity.id, String(entity.lifeRevision)]),
    );
    if (!inactive.length && !Object.keys(changed).length) return;
    await this.db.query(
      `UPDATE npc_ai_jobs SET cancel_requested=true,result_code='NPC_LIFECYCLE_CHANGED'
      WHERE campaign_id=$1 AND subject_kind='npc' AND status IN ('reserved','result_received','validated')
      AND NOT cancel_requested AND (npc_id=ANY($2::text[]) OR
        ($3::jsonb ? npc_id AND COALESCE(context->>'lifeRevision','0')<>($3::jsonb->>npc_id)))`,
      [id, inactive, JSON.stringify(changed)],
    );
  }
  private async processAi(id: string, live: Live) {
    await this.cancelStaleNpcLifecycleJobs(id, live.state);
    await this.ai.sweep(id);
    for (const job of await this.ai.ready(id)) {
      if (job.purpose === 'story_turn') {
        await this.story.complete(id, live, job);
        continue;
      }
      const { next, accepted, intentOutcome, narrativeOutcome, decisionCode } =
        await this.evaluateDecision(id, live.state, job);
      await this.persist(
        id,
        live,
        next,
        accepted ? 'npc.ai.accepted' : 'npc.ai.stale',
        undefined,
        async (c) => {
          await this.ai.finalize(c, job.id, accepted ? 'committed' : 'stale');
          if (decisionCode)
            await c.query('UPDATE npc_ai_jobs SET result_code=$2 WHERE id=$1', [
              job.id,
              decisionCode,
            ]);
          if (accepted && job.purpose === 'speech' && job.context.deferredSpeechId)
            await this.story.writeDeferredReply(
              c,
              id,
              live.state,
              next,
              job.context,
              live.eventSeq + 1,
            );
          await this.saveIntentOutcome(c, intentOutcome);
          await this.saveNarrativeOutcome(c, id, next, narrativeOutcome);
        },
      );
    }
    await this.cancelStaleNpcLifecycleJobs(id, live.state);
    live.aiPending = await this.ai.pending(id);
    if (live.aiPending) this.dispatchAi(id);
  }
  async list(req: Request, adventureId?: unknown) {
    const u = await this.auth.require(req);
    return listCampaigns(this.db, u.id, adventureId);
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
        z
          .object({
            template: z.literal('observatory-v1'),
            heroId: z.uuid().optional(),
            directorProfileId: directorProfileIdSchema.optional(),
            turnBased: z.boolean().optional(),
          })
          .strict(),
        z
          .object({
            playableVersionId: z.uuid(),
            startPreparationId: z.uuid().optional(),
            heroId: z.uuid().optional(),
            directorProfileId: directorProfileIdSchema.optional(),
            turnBased: z.boolean().optional(),
          })
          .strict(),
      ])
      .parse(body);
    const u = await this.auth.require(req);
    let id = randomUUID();
    const actorId = `player-${u.id}`,
      seed = randomInt(1, 2147483647);
    await this.db.tx(async (c) => {
      const count = await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [u.id]);
      if (!count.rowCount) fail(403, 'FORBIDDEN', 'FORBIDDEN');
      const sourceVersion = 'playableVersionId' in input ? input.playableVersionId : null;
      const preparation =
        'startPreparationId' in input && input.startPreparationId
          ? (
              await c.query(
                'SELECT * FROM game_start_preparations WHERE id=$1 AND actor_id=$2 FOR UPDATE',
                [input.startPreparationId, u.id],
              )
            ).rows[0]
          : null;
      if ('startPreparationId' in input && input.startPreparationId && !preparation)
        fail(404, 'NOT_FOUND', 'NOT_FOUND');
      if (preparation) {
        if (
          preparation.source_version_id !== sourceVersion ||
          preparation.hero_id !== (input.heroId ?? null) ||
          input.turnBased === false ||
          (input.directorProfileId !== undefined &&
            input.directorProfileId !== preparation.director_profile_id)
        )
          fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
        const source = await this.playable.sourceForStart(c, u.id, sourceVersion!);
        if (source.checksum !== preparation.source_checksum)
          fail(409, 'START_SOURCE_CHANGED', 'START_SOURCE_CHANGED');
        if (preparation.campaign_id) {
          id = preparation.campaign_id;
          return;
        }
        if (preparation.status !== 'ready')
          fail(409, 'START_PREPARATION_REQUIRED', 'START_PREPARATION_REQUIRED');
      }
      const campaigns = await c.query(
        'SELECT count(*)::int AS n FROM game_campaigns WHERE owner_id=$1',
        [u.id],
      );
      if (campaigns.rows[0].n >= 20) fail(429, 'RATE_LIMITED', 'RATE_LIMITED');
      const catalog = await readDirectorCatalog(transactionQueries(c));
      const selectedDirector = directorProfile(
        catalog,
        preparation?.director_profile_id ?? input.directorProfileId ?? catalog.defaultProfileId,
        !preparation,
      );
      const selectedHero = await readOwnedHero(c, u.id, input.heroId);
      if (preparation && digest(selectedHero) !== digest(preparation.hero_snapshot))
        fail(409, 'START_SOURCE_CHANGED', 'START_SOURCE_CHANGED');
      const state = sourceVersion
        ? await this.playable.resolveForStart(
            c,
            u.id,
            sourceVersion,
            actorId,
            seed,
            preparation?.compiled,
          )
        : createObservatoryState([actorId], seed);
      // Authored launches default to sequential turns, including older clients omitting the flag.
      // Explicit false remains a compatibility path for historical clients/fixtures only.
      const useTurnBased = input.turnBased ?? Boolean(sourceVersion);
      if (useTurnBased && !state.turnController) {
        if (state.rulesetVersion !== 'hybrid-v3') {
          if (sourceVersion)
            fail(409, 'TURN_RULESET_UPGRADE_REQUIRED', 'TURN_RULESET_UPGRADE_REQUIRED');
          const compiled = compilePlayableDraft(createCompleteObservatoryDraft());
          if (!compiled.playable) fail(400, 'INVALID_MAP', 'INVALID_MAP');
          const replacement = createStateFromPlayable(compiled.playable!, [actorId], seed);
          Object.assign(state, replacement);
        }
        const initialized = initializeTurnController(state, [actorId]);
        if (initialized.error) fail(409, initialized.error, initialized.error);
        Object.assign(state, initialized.state);
      }
      dressHero(state, actorId, selectedHero);
      await c.query(
        'INSERT INTO game_campaigns(id,owner_id,playable_version,state,source_version_id,director_profile_id) VALUES($1,$2,$3,$4,$5,$6)',
        [
          id,
          u.id,
          sourceVersion ?? 'observatory-v1',
          JSON.stringify(state),
          sourceVersion,
          selectedDirector.id,
        ],
      );
      await c.query(
        "INSERT INTO game_members(campaign_id,user_id,actor_id,status) VALUES($1,$2,$3,'accepted')",
        [id, u.id, actorId],
      );
      await pinHero(c, id, u.id, input.heroId, selectedHero);
      if (preparation)
        await c.query(
          "UPDATE game_start_preparations SET status='started',campaign_id=$2 WHERE id=$1",
          [preparation.id, id],
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
      if (result.state.turnController) {
        const registered = registerTurnParticipant(result.state, String(rows[0].actor_id));
        if (registered.error) fail(409, registered.error, registered.error);
        result.state = registered.state;
      }
      dressHero(result.state, String(rows[0].actor_id), selectedHero);
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
      let state = structuredClone(live.state);
      if (state.turnController) {
        const removed = removeTurnParticipant(state, `player-${userId}`);
        if (removed.error) fail(409, removed.error, removed.error);
        state = removed.state;
      }
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
        if (state.turnController)
          await c.query(
            "UPDATE game_npc_decision_requests SET status='cancelled',result_code='TURN_PARTICIPANT_REVOKED' WHERE campaign_id=$1 AND status IN ('queued','scheduled')",
            [id],
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
      if (live.state.turnController) {
        if (!input.operationId || !input.turnFence)
          fail(400, 'TURN_FENCE_REQUIRED', 'TURN_FENCE_REQUIRED');
        const hash = digest({
          type: 'turn.move',
          target: input.target,
          inputSeq: input.inputSeq,
          movementGeneration: input.movementGeneration,
          turnFence: input.turnFence,
        });
        const existing = (
          await this.db.query(
            'SELECT request_hash,result FROM game_operations WHERE campaign_id=$1 AND actor_id=$2 AND operation_id=$3',
            [id, a.actorId, input.operationId],
          )
        )[0];
        if (existing) {
          if (existing.request_hash !== hash)
            fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
          await this.refreshArt(id, live, true);
          const replay = structuredClone(existing.result);
          if (replay.projection?.artBindings) {
            const visible = new Set(
              (projectState(live.state, a.actorId).artBindings ?? []).map(
                (binding) => `${binding.slot}:${binding.revisionId}`,
              ),
            );
            replay.projection.artBindings = replay.projection.artBindings.filter(
              (binding: { slot: string; revisionId: string }) =>
                visible.has(`${binding.slot}:${binding.revisionId}`) &&
                !this.unavailableArt.has(binding.revisionId),
            );
          }
          return replay;
        }
        if (input.connectionEpoch !== (live.actorEpochs[a.actorId] ?? live.epoch))
          fail(409, 'STALE_STATE', 'STALE_STATE');
        const moved =
          input.inputSeq <= (live.state.entities[a.actorId].lastInputSeq ?? -1) ||
          input.movementGeneration !== (live.state.entities[a.actorId].movementGeneration ?? 0)
            ? { state: live.state, events: [], error: 'STALE_STATE' as const }
            : applyTurnMove(live.state, a.actorId, input.target, input.turnFence!);
        const next = moved.error
          ? live.state
          : recordNpcEvents(live.state, moved.state, moved.events, input.operationId!).state;
        if (!moved.error) next.entities[a.actorId].lastInputSeq = input.inputSeq;
        const response = {
          ...(await this.envelope(id, live, a.actorId)),
          status: moved.error ? 'rejected' : 'committed',
          code: moved.error,
          operationId: input.operationId,
          events: projectGameEvents(next, a.actorId, moved.events),
          projection: this.project(next, a.actorId),
        };
        response.projectionRevision = response.projection.revision;
        await this.persist(id, live, next, 'turn.move', {
          actorId: a.actorId,
          command: { operationId: input.operationId! },
          hash,
          response,
        });
        return response;
      }
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
      if (live.state.turnController) return this.envelope(id, live, a.actorId);
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
      let next = result.error
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
          next.turnController ? { turnId: command.operationId, segmentIndex: 0 } : undefined,
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
          undefined,
          resolveReplyLocale(req, command.speech.replyLocale, a.user.settings.language),
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
        if (next.turnController) {
          const queued = queueTurnSpeech(
            next,
            a.actorId,
            {
              id: decisionRequest.id,
              recipientId: command.npcId,
              utteranceId: replyToObservationId!,
              channel: command.speech.channel,
              audienceIds: context.audienceIds,
            },
            command.turnFence!,
          );
          if (queued.error) fail(409, queued.error, queued.error);
          next = queued.state;
          decisionRequest.context = {
            ...decisionRequest.context,
            deferredSpeechId: decisionRequest.id,
            turnOrder: next.turnController!.deferredSpeech.find(
              (item) => item.id === decisionRequest!.id,
            )!.sequence,
          };
        }
      }
      const ordinaryRoundId =
        !result.error &&
        command.type === 'turn.end' &&
        command.ordinaryGeneration === true &&
        this.ai.releaseGeneration() &&
        a.user.id === a.ownerId &&
        live.state.turnController?.phase === 'player'
          ? live.state.turnController.roundId
          : undefined;
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
          if (ordinaryRoundId !== undefined)
            await c.query(
              `INSERT INTO game_ordinary_round_consents(campaign_id,round_id,owner_id,operation_id)
               VALUES($1,$2,$3,$4) ON CONFLICT(campaign_id,round_id) DO NOTHING`,
              [id, ordinaryRoundId, a.user.id, command.operationId],
            );
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
    if (state.turnController) {
      const reject = (error: GameResult['error'] = 'INVALID_ACTION'): GameResult => ({
        state,
        events: [],
        error,
      });
      if (!command.turnFence) return reject('STALE_STATE');
      if (command.type === 'turn.end') return endPlayerTurn(state, actorId, command.turnFence);
      if (
        command.type === 'turn.reaction' &&
        (command.decision === 'defend' || command.decision === 'decline')
      )
        return resolveTurnReaction(state, actorId, command.decision, command.turnFence);
      if (command.type === 'action' && command.action)
        return applyTurnAction(state, actorId, command.action, command.turnFence);
      if (command.type !== 'npc.speech' && command.type !== 'npc.promise') return reject();
      const fence = turnFence(state);
      if (
        !fence ||
        !matchesTurnFence(state, command.turnFence) ||
        state.turnController.phase !== 'player' ||
        state.turnController.activeActorId !== actorId
      )
        return reject('STALE_STATE');
    }
    if (command.type === 'action' && command.action)
      return applyAction(state, actorId, command.action);
    if (command.type === 'npc.speech' && command.npcId && command.speech)
      return applyNpcSpeech(state, actorId, command.npcId, command.speech, {
        suppressReply: true,
        ...(state.turnController
          ? { identity: { turnId: command.operationId, segmentIndex: 0 } }
          : {}),
      });
    if (
      command.type === 'npc.promise' &&
      command.npcId &&
      command.promiseId &&
      (command.decision === 'accept' || command.decision === 'decline')
    )
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
    preflight?: (c: import('pg').PoolClient) => Promise<void>,
  ) {
    const seq = live.eventSeq + 1;
    const presentationOnly = kind === 'narrative.preferences.updated';
    const retentionDue =
      !presentationOnly &&
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
        if (preflight) await preflight(c);
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
        if (!presentationOnly && state.objectives?.length && !live.paused) {
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
        if (!presentationOnly) await archiveNpcEpisodes(c, id, state);
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
  /** One admitted addressed message, kept distinct until the NPC/world phase. */
  private deferredSpeechContext(state: GameState, request: NpcDecisionRequest) {
    const r = request.context;
    state = previewPendingStorySpeech(state, request.npcId, r);
    const current = this.speechContext(
      state,
      request.npcId,
      String(r.recipientId),
      r.channel as 'say' | 'whisper',
      undefined,
      r.topicId as string | undefined,
      r.replyToObservationId as string | undefined,
      r.deferredSpeechId as string | undefined,
      r.replyLocale as Locale | undefined,
    );
    return {
      ...current,
      storyTurnId: r.storyTurnId,
      segmentIndex: r.segmentIndex,
      knowledgeRevision: r.knowledgeRevision,
      lifeRevision: r.lifeRevision ?? 0,
      ...(typeof r.awaitStoryDirector === 'string'
        ? { awaitStoryDirector: r.awaitStoryDirector }
        : {}),
      ...(r.pendingStorySpeech
        ? {
            pendingStorySpeech: r.pendingStorySpeech,
            pendingStorySpeechKnowledgeRevision:
              r.pendingStorySpeechKnowledgeRevision ??
              state.npcBrains?.[request.npcId]?.living?.knowledgeRevision,
          }
        : {}),
      deferredSpeechId: r.deferredSpeechId,
      turnOrder: r.turnOrder,
      ...(r.responseOptional ? { responseOptional: true } : {}),
      ...safeRoleplayExtras(r, current),
      mockProposal: createMockNpcPublicResponse(current),
    };
  }
  /** One spoken source, any number of listeners. Contexts freeze later at world entry. */
  private prepareAreaTurnSpeech(
    state: GameState,
    actorId: string,
    speech: z.infer<typeof npcSpeechSchema> & {
      presentationKind?: 'attempt';
      observeOnly?: boolean;
    },
    userId: string,
    identity: { turnId: string; segmentIndex: number },
    _legacyTargetNpcId?: string,
  ) {
    const { presentationKind, observeOnly, ...utterance } = speech;
    const audienceIds =
      presentationKind === 'attempt'
        ? npcRoleplayObserverIds(state, actorId, utterance)
        : npcSpeechListenerIds(state, actorId, utterance);
    // Spatial speech has no selected recipient, including requests from older clients.
    const applied = applyNpcSpeech(state, actorId, undefined, utterance, {
      suppressReply: true,
      identity,
      presentationKind,
    });
    if (applied.error) fail(409, applied.error, applied.error);
    let next = recordNpcEvents(
      state,
      applied.state,
      applied.events,
      `turn:${identity.turnId}:${identity.segmentIndex}`,
    ).state;
    const requests: NpcDecisionRequest[] = [];
    for (const npcId of audienceIds.filter(
      (id) => !observeOnly && next.entities[id]?.kind === 'npc' && next.npcBrains?.[id]?.living,
    )) {
      const marker = admittedNpcSpeechObservationId(next, actorId, npcId, utterance, identity);
      if (!marker) continue; // E.g. an encounter participant could not admit this utterance.
      const hash = digest({ ...identity, npcId });
      const requestId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
      const queued = queueTurnSpeech(
        next,
        actorId,
        {
          id: requestId,
          recipientId: npcId,
          utteranceId: marker,
          channel: speech.channel,
          audienceIds,
        },
        turnFence(next)!,
      );
      if (queued.error) fail(409, queued.error, queued.error);
      next = queued.state;
      const ref = next.turnController!.deferredSpeech.find((item) => item.id === requestId)!;
      requests.push({
        id: requestId,
        npcId,
        purpose: 'speech',
        causeKey: `turn-dialogue:${requestId}`,
        requesterUserId: userId,
        recipientActorId: actorId,
        context: {
          contextHash: digest({ requestId, marker }),
          channel: speech.channel,
          recipientId: actorId,
          replyLocale: speech.replyLocale,
          replyToObservationId: marker,
          storyTurnId: identity.turnId,
          segmentIndex: identity.segmentIndex,
          deferredSpeechId: requestId,
          turnOrder: ref.sequence,
          responseOptional: true,
          knowledgeRevision: next.npcBrains![npcId].living!.knowledgeRevision,
          lifeRevision: next.entities[npcId].lifeRevision ?? 0,
        },
      });
    }
    return {
      state: next,
      requests,
      audienceIds,
      sourceId: next.npcUtterances?.find(
        (item) =>
          item.speakerId === actorId && !state.npcUtterances?.some((old) => old.id === item.id),
      )?.id,
    };
  }
  private prepareTurnSpeech(
    state: GameState,
    actorId: string,
    npcId: string,
    speech: z.infer<typeof npcSpeechSchema> & { presentationKind?: 'attempt' },
    requestId: string,
    userId: string,
    identity: { turnId: string; segmentIndex: number },
  ) {
    const utterance = { channel: speech.channel, text: speech.text };
    const applied = applyNpcSpeech(state, actorId, npcId, utterance, {
      suppressReply: true,
      identity,
      presentationKind: speech.presentationKind,
    });
    if (applied.error) fail(409, applied.error, applied.error);
    let next = recordNpcEvents(
      state,
      applied.state,
      applied.events,
      `turn:${identity.turnId}:${identity.segmentIndex}`,
    ).state;
    const marker = admittedNpcSpeechObservationId(next, actorId, npcId, utterance, identity);
    if (!marker) fail(409, 'STALE_STATE', 'STALE_STATE');
    const context = this.speechContext(
      next,
      npcId,
      actorId,
      speech.channel,
      undefined,
      undefined,
      marker,
      undefined,
      speech.replyLocale,
    );
    const queued = queueTurnSpeech(
      next,
      actorId,
      {
        id: requestId,
        recipientId: npcId,
        utteranceId: marker!,
        channel: speech.channel,
        audienceIds: context.audienceIds,
      },
      turnFence(state)!,
    );
    if (queued.error) fail(409, queued.error, queued.error);
    next = queued.state;
    const ref = next.turnController!.deferredSpeech.find((item) => item.id === requestId)!;
    const request: NpcDecisionRequest = {
      id: requestId,
      npcId,
      purpose: 'speech',
      causeKey: `turn-dialogue:${requestId}`,
      requesterUserId: userId,
      recipientActorId: actorId,
      context: {
        ...context,
        storyTurnId: identity.turnId,
        segmentIndex: identity.segmentIndex,
        deferredSpeechId: requestId,
        turnOrder: ref.sequence,
        knowledgeRevision: next.npcBrains?.[npcId]?.living?.knowledgeRevision ?? 0,
        lifeRevision: next.entities[npcId].lifeRevision ?? 0,
        mockProposal: createMockNpcPublicResponse(context),
      },
    };
    return {
      state: next,
      events: [...applied.events, ...queued.events],
      request,
      audienceIds: context.audienceIds,
      sourceId: next.npcUtterances?.find(
        (item) =>
          item.speakerId === actorId && !state.npcUtterances?.some((old) => old.id === item.id),
      )?.id,
    };
  }
  /** No wall-clock gameplay ticks. Finite ordered jobs/plans run only in the world phase. */
  private async reconcileWorldOrphans(id: string) {
    // A missing job is not permission to retry. Terminalize only demonstrably
    // unpaid orphans; preserve every permit, hold, liability and accepted consent.
    await this.db.query(
      `UPDATE game_npc_decision_requests SET status='failed',result_code='MISSING_PROVIDER_JOB'
      WHERE id IN (SELECT r.id FROM game_npc_decision_requests r
        WHERE r.campaign_id=$1 AND r.status='scheduled' AND r.job_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM npc_ai_jobs j WHERE j.campaign_id=r.campaign_id AND
          (j.operation_id=r.id OR j.request_meta->>'runtimeRequestId'=r.id::text))
        AND NOT EXISTS(SELECT 1 FROM live_test_text_permits p WHERE p.request_id=r.id)
        AND NOT EXISTS(SELECT 1 FROM generation_budget_reservations b WHERE b.operation_key='manual-text:'||r.id::text)
        AND NOT EXISTS(SELECT 1 FROM spark_holds h WHERE h.source_id=r.id::text)
        AND NOT EXISTS(SELECT 1 FROM game_world_generation_batches b WHERE b.campaign_id=r.campaign_id AND b.state='accepted'
          AND b.entries @> jsonb_build_array(jsonb_build_object('requestId',r.id::text)))
        ORDER BY r.created_at,r.id LIMIT 8)`,
      [id],
    );
  }
  private async blockOrdinaryRound(id: string, roundId: string, code: string) {
    await this.db.tx(async (c) => {
      const blocked = await c.query(
        `UPDATE game_ordinary_round_consents SET state='blocked',result_code=$3,updated_at=now()
         WHERE campaign_id=$1 AND round_id=$2 AND state='pending' RETURNING round_id`,
        [id, roundId, code],
      );
      if (!blocked.rowCount || code === 'IMAGE_ESTIMATE_RISK_CONSENT_REQUIRED') return;
      const unspent = await c.query(
        `SELECT id FROM game_npc_decision_requests WHERE campaign_id=$1 AND status='queued'
         AND context->'turnFence'->>'roundId'=$2`,
        [id, roundId],
      );
      for (const request of unspent.rows)
        await this.worldGeneration.failUnspent(id, request.id, code, c);
    });
  }
  private async admitOrdinaryRound(id: string) {
    const cached = this.live.get(id);
    if (
      this.stopping ||
      !cached ||
      cached.paused ||
      cached.state.turnController?.phase !== 'world' ||
      this.ordinaryAdmissions.has(id) ||
      (this.ordinaryAdmissionChecks.get(id) ?? 0) > Date.now()
    )
      return;
    this.ordinaryAdmissions.add(id);
    this.ordinaryAdmissionChecks.set(id, Date.now() + 1000);
    let attemptedRoundId: string | undefined;
    try {
      await this.withRuntimeVisionQuote(() =>
        this.serial(id, async () => {
          const live = this.live.get(id);
          if (this.stopping || !live || live.paused || live.state.turnController?.phase !== 'world')
            return;
          const roundId = live.state.turnController.roundId;
          const authority = (
            await this.db.query(
              `SELECT owner_id,operation_id FROM game_ordinary_round_consents
           WHERE campaign_id=$1 AND round_id=$2 AND state='pending'`,
              [id, roundId],
            )
          )[0];
          if (!authority) return;
          attemptedRoundId = roundId;
          await this.scheduleRoundRequests(id, live);
          // End turn covers ordinary text only. A committed missing-location intent
          // must keep its single explicit text+image consent, before any quoting.
          const pendingLocations = await this.db.tx((c) =>
            this.worldGeneration.pendingLocationCount(c, id, live.state),
          );
          if (pendingLocations > 0) {
            await this.blockOrdinaryRound(id, roundId, 'IMAGE_ESTIMATE_RISK_CONSENT_REQUIRED');
            return;
          }
          try {
            const result = await this.worldGeneration.quote(authority.owner_id, id, live.state, {
              operationId: authority.operation_id,
            });
            await this.worldGeneration.consent(
              authority.owner_id,
              id,
              live.state,
              {
                operationId: authority.operation_id,
                quoteId: result.quote.id,
                consent: true,
              },
              roundId,
            );
            live.decisionsPending = true;
          } catch (error) {
            // Preflight requests and transport/database uncertainty must reach the
            // outer retry wrapper. Never turn an uncertain commit into a new quote.
            if (!(error instanceof ApiException)) throw error;
            const code = (error.getResponse() as { code: string }).code;
            await this.blockOrdinaryRound(id, roundId, code);
            live.decisionsPending = true;
          }
        }),
      );
    } catch (error) {
      // A definitive count failure is terminal for this round, never a polling
      // retry loop. Connection/commit uncertainty retains the same durable id.
      if (attemptedRoundId !== undefined && error instanceof ApiException) {
        const code = (error.getResponse() as { code: string }).code;
        try {
          await this.serial(id, () => this.blockOrdinaryRound(id, attemptedRoundId!, code));
        } catch {
          /* Database failure leaves the original authority unchanged. */
        }
      }
    } finally {
      this.ordinaryAdmissions.delete(id);
    }
  }
  private async advanceTurnWorld(id: string, live: Live) {
    const turn = live.state.turnController;
    if (!turn || turn.phase !== 'world') return;
    await this.reconcileWorldOrphans(id);
    if (live.aiPending) await this.processAi(id, live);
    await this.scheduleAutonomousRequests(id, live);
    await this.processDecisionRequests(id, live);
    // Unknown provider liability remains in its ledger. It does not strand the game phase.
    await this.db.query(
      `UPDATE game_npc_decision_requests r SET status='failed',result_code='PROVIDER_OUTCOME_UNKNOWN'
      FROM npc_ai_jobs j WHERE r.campaign_id=$1 AND j.campaign_id=r.campaign_id
      AND (r.job_id=j.id OR j.operation_id=r.id OR j.request_meta->>'runtimeRequestId'=r.id::text)
      AND r.status IN ('queued','scheduled') AND j.status='reconciling'`,
      [id],
    );
    const refs = live.state.turnController!.deferredSpeech;
    if (refs.length) {
      const terminal = await this.db.query(
        `SELECT r.id FROM game_npc_decision_requests r LEFT JOIN npc_ai_jobs j ON j.id=r.job_id
        WHERE r.campaign_id=$1 AND r.id=ANY($2::uuid[]) AND (r.status NOT IN ('queued','scheduled') OR j.status IN ('stale','failed','cancelled','reconciling'))`,
        [id, refs.map((ref) => ref.id)],
      );
      let state = live.state;
      for (const row of terminal) {
        const resolved = markTurnSpeechResolved(state, String(row.id), turnFence(state)!);
        if (!resolved.error) state = resolved.state;
      }
      if (state !== live.state) await this.persist(id, live, state, 'turn.speech.drained');
    }
    const work = await this.db.query(
      `SELECT 1 FROM game_npc_decision_requests r LEFT JOIN npc_ai_jobs j ON j.id=r.job_id
      WHERE r.campaign_id=$1 AND (r.status='queued' OR (r.status='scheduled' AND (j.id IS NULL OR j.status IN ('queued','reserved','running','result_received','validated')))) LIMIT 1`,
      [id],
    );
    if (work.length || live.state.turnController!.deferredSpeech.length) return;
    // Every NPC gets the existing bounded local policy opportunity. This is pure
    // deterministic work, not another model request or a compulsory spoken reply.
    const roundRoster = (
      await this.db.query(
        'SELECT roster FROM game_world_round_rosters WHERE campaign_id=$1 AND round_id=$2',
        [id, live.state.turnController!.roundId],
      )
    )[0]?.roster as { npcId: string; consideration: string }[] | undefined;
    const routine = stepLivingNpcs(live.state, {
      deferredNpcIds: roundRoster
        ? Object.keys(live.state.npcBrains ?? {}).filter(
            (npcId) =>
              !roundRoster.some(
                (entry) => entry.npcId === npcId && entry.consideration === 'continue',
              ),
          )
        : undefined,
    });
    let state = recordNpcEvents(
      live.state,
      routine.state,
      routine.events,
      `world:${live.state.turnController!.roundId}:routine`,
    ).state;
    for (const npcId of (
      roundRoster?.map((entry) => entry.npcId) ?? Object.keys(state.npcBrains ?? {})
    ).sort()) {
      const brain = state.npcBrains![npcId];
      // A rejected round intention remains blocked feedback for the next decision.
      // Do not replace it with an old companion action or a fabricated successful wait.
      if (
        !brain.plan.length &&
        brain.living?.lastActionOutcome?.status === 'blocked' &&
        brain.living.lastActionOutcome.roundId === state.turnController!.roundId
      )
        continue;
      const companion =
        worldTurnCompanionContinuation(state, npcId) ??
        (brain.cursor >= brain.plan.length ? companionAction(state, npcId) : undefined);
      const applied = companion
        ? applyWorldTurnAction(state, npcId, companion, turnFence(state)!)
        : stepWorldNpcPlan(state, npcId);
      if (!applied.error || applied.error === 'PATH_BLOCKED' || applied.error === 'ROUND_LOCKED')
        state = recordNpcEvents(
          state,
          applied.state,
          applied.events,
          `world:${state.turnController!.roundId}:${npcId}:action`,
        ).state;
      if (state.turnController!.phase !== 'world') {
        await this.persist(id, live, state, 'turn.world.reaction');
        return;
      }
    }
    const finished = finishWorldPhase(state, turnFence(state)!);
    if (!finished.error)
      await this.persist(id, live, finished.state, 'turn.world.completed', undefined, async (c) => {
        // A round with no paid work must not leave a fictitious pending charge.
        await c.query(
          `UPDATE game_ordinary_round_consents SET state='accepted',updated_at=now()
           WHERE campaign_id=$1 AND round_id=$2 AND state='pending'`,
          [id, turn.roundId],
        );
      });
    else if (state !== live.state) await this.persist(id, live, state, 'turn.world.actions');
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
      this.ordinaryAdmissionChecks.delete(id);
      for (const actor of Object.keys(live.state.entities))
        this.projections.delete(actor + ':' + live.state.seed);
      return;
    }
    if (live.paused) return;
    await this.refreshArt(id, live);
    if (live.state.turnController) {
      await this.advanceTurnWorld(id, live);
      return;
    }
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

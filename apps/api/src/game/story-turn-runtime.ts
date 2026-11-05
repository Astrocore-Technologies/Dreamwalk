import { settlePendingStorySpeech } from './pending-story-speech';
import { isActorConscious } from '@dreamwalk/contracts';
import { runtimeQuoteIdentity } from '../ai/runtime-map-preflight';
import { aggregateFunding, heldFunding, optionalFunding } from '../generation/currency-funding';
import { totalQuotedSparkSubunits, commonQuotedSparkRate } from '../generation/sparks-quote-total';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
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
  type StoryAttackOutcome,
  type StoryTurnSubmit,
  type StoryTurnInput,
  type StoryTurnQuoteResponse,
  type StoryQuote,
  type StoryTurnReceipt,
  type StoryTurnFeed,
  type StoryFeedEntry,
  type StoryTurnProposal,
} from '@dreamwalk/contracts';
import {
  applyTurnAction,
  applyAction,
  resolveTravelRequest,
  recordNpcEvents,
  parsePlayerTextAction,
  storyContactOutcomeCode,
  isNpcStoryContact,
  storyTurnMode,
  storyPrivateAudience,
  storyImpactContext,
  turnFence,
  matchesTurnFence,
  canNpcHear,
  npcRoleplayObserverIds,
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
import type { ReadyDecision, DecisionContext } from '../ai/types';
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
    prepare?: (c: PoolClient, state: GameState) => Promise<GameState>,
  ): Promise<void>;
  canUseFrozenTravel?(campaignId: string, turnId: string): Promise<boolean>;
  rebaseTravel?(
    campaignId: string,
    turnId: string,
    state: GameState,
    input: StoryTurnInput,
    proposal: unknown,
  ): Promise<{ input: StoryTurnInput; proposal: StoryTurnProposal } | null>;
  admitTravel?(
    campaignId: string,
    turnId: string,
    proposal: StoryTurnProposal,
  ): Promise<(c: PoolClient, state: GameState) => Promise<GameState>>;
  dispatch(id: string): void;
  failWorldRequest(campaignId: string, requestId: string, code: string): Promise<void>;
  deferredSpeechContext(state: GameState, request: NpcDecisionRequest): DecisionContext;
  prepareAreaTurnSpeech?(
    state: GameState,
    actorId: string,
    speech: {
      channel: 'say' | 'whisper';
      text: string;
      replyLocale?: Locale;
      presentationKind?: 'attempt';
      observeOnly?: boolean;
    },
    userId: string,
    identity: { turnId: string; segmentIndex: number },
    targetNpcId?: string,
  ): { state: GameState; requests: NpcDecisionRequest[]; audienceIds: string[]; sourceId?: string };
  prepareTurnSpeech(
    state: GameState,
    actorId: string,
    npcId: string,
    speech: {
      channel: 'say' | 'whisper';
      text: string;
      replyLocale?: Locale;
      presentationKind?: 'attempt';
    },
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
type QuotedReply = { request: NpcDecisionRequest; quote: StoryQuote; batchId?: string };
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
function aggregateReplyQuote(id: string, quotedReplies: QuotedReply[]): StoryQuote {
  const reserve = quotedReplies.reduce(
    (sum, reply) => sum + (reply.quote.providerReserveMicros ?? 0),
    0,
  );
  const estimate = quotedReplies.reduce(
    (sum, reply) =>
      sum + (reply.quote.estimatedTotalMicros ?? reply.quote.providerReserveMicros ?? 0),
    0,
  );
  if (!Number.isSafeInteger(reserve) || !Number.isSafeInteger(estimate))
    fail(409, 'SPARK_PRICE_UNVERIFIED', 'SPARK_PRICE_UNVERIFIED');
  return {
    id,
    credits: 0,
    demo: false,
    external: true,
    requiresConsent: true,
    chargeUnit: 'sparks',
    sparkReservedSubunits: totalQuotedSparkSubunits(quotedReplies.map((reply) => reply.quote)),
    ...commonQuotedSparkRate(quotedReplies.map((reply) => reply.quote)),
    ...optionalFunding(aggregateFunding(quotedReplies.map((reply) => reply.quote))),
    providerUpperMicros: null,
    providerReserveMicros: reserve,
    ...(quotedReplies.some((r) => r.quote.runtimeMapImages)
      ? {
          runtimeMapImages: quotedReplies.reduce(
            (sum, r) => sum + (r.quote.runtimeMapImages ?? 0),
            0,
          ),
        }
      : {}),
    estimatedTotalMicros: estimate,
    providerEnforcesQuotedCap: false,
    expiresAt: new Date(
      Math.min(...quotedReplies.map((reply) => Date.parse(reply.quote.expiresAt))),
    ).toISOString(),
    provider: quotedReplies[0].quote.provider,
    policyVersion: quotedReplies[0].quote.policyVersion,
    estimateSnapshot: {
      schemaVersion: 1,
      costBasis: 'operator_estimate',
      fingerprint: digest(quotedReplies.map((reply) => reply.quote)),
      reserveMicros: reserve,
      estimatedTotalMicros: estimate,
      providerEnforcesQuotedCap: false,
    },
  };
}
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
        `SELECT t.*,tp.scene->>'name' AS travel_name,tp.state AS travel_state,r.status AS travel_request_status,ij.status AS travel_image_status,ih.status AS travel_spark_status,ih.reserved_subunits AS travel_spark_reserved,ih.captured_subunits AS travel_spark_captured,ih.sparks_reserved_subunits AS travel_spark_paid_reserved,EXISTS(SELECT 1 FROM game_npc_decision_requests pending WHERE pending.campaign_id=t.campaign_id AND pending.context->>'storyTurnId'=t.id::text AND pending.status='queued' AND pending.result_code='GENERATION_QUOTE_STALE') AS generation_needs_confirmation,r.status AS request_status,j.status AS job_status,j.credits AS job_credits,sh.status AS spark_status,sh.reserved_subunits AS spark_reserved,sh.captured_subunits AS spark_captured,sh.sparks_reserved_subunits AS spark_paid_reserved FROM game_story_turns t LEFT JOIN game_location_travel_preparations tp ON tp.id=t.id LEFT JOIN image_generation_jobs ij ON ij.id=tp.image_job_id LEFT JOIN spark_holds ih ON ih.id=ij.spark_quote_id LEFT JOIN game_npc_decision_requests r ON r.id=t.decision_request_id LEFT JOIN npc_ai_jobs j ON j.id=r.job_id LEFT JOIN spark_holds sh ON sh.id=COALESCE(j.spark_hold_id,(SELECT br.spark_quote_id FROM live_test_text_permits p JOIN generation_budget_reservations br ON br.id=p.reservation_id WHERE p.job_id=j.id OR p.request_id::text=j.request_meta->>'runtimeRequestId' LIMIT 1)) WHERE t.campaign_id=$1 AND t.id=$2 ${userId ? 'AND t.requester_user_id=$3' : ''}`,
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
      generationNeedsConfirmation: r.generation_needs_confirmation === true,
      ...(r.travel_name
        ? {
            travel: {
              destinationName: r.travel_name,
              status:
                r.result_code === 'LOCATION_TRAVEL_DECLINED'
                  ? 'declined'
                  : ['failed', 'cancelled'].includes(r.travel_request_status)
                    ? 'failed'
                    : r.travel_state,
              ...(r.travel_image_status ? { imageStatus: r.travel_image_status } : {}),
              ...(r.travel_spark_status
                ? {
                    sparkStatus: r.travel_spark_status,
                    sparkReservedSubunits: String(r.travel_spark_reserved),
                    sparkCapturedSubunits:
                      r.travel_spark_captured === null ? null : String(r.travel_spark_captured),
                    ...(r.travel_spark_paid_reserved == null
                      ? {}
                      : {
                          funding: heldFunding({
                            reserved_subunits: r.travel_spark_reserved,
                            sparks_reserved_subunits: r.travel_spark_paid_reserved,
                            captured_subunits: r.travel_spark_captured,
                          }),
                        }),
                  }
                : {}),
            },
          }
        : {}),
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
      ...(r.spark_status
        ? {
            ...(r.spark_paid_reserved == null
              ? {}
              : {
                  funding: heldFunding({
                    reserved_subunits: r.spark_reserved,
                    sparks_reserved_subunits: r.spark_paid_reserved,
                    captured_subunits: r.spark_captured,
                  }),
                }),
            sparkStatus: r.spark_status,
            sparkReservedSubunits: String(r.spark_reserved),
            sparkCapturedSubunits: r.spark_captured === null ? null : String(r.spark_captured),
          }
        : {}),
      generationCost:
        r.job_status === 'committed'
          ? Number(r.job_credits ?? 0)
          : ['stale', 'failed', 'cancelled'].includes(r.job_status)
            ? 0
            : null,
      confirmationCost: 0,
    };
  }
  async reconcileTerminalTravel(id: string) {
    // Native parse/schema failure never reaches ready()/complete(). Retire only the
    // exact linked terminal text operation; images, wallet holds and costs stay intact.
    await this.db.query(
      `WITH terminal AS (
        UPDATE game_npc_decision_requests r SET status='failed',result_code=COALESCE(j.result_code,'LOCATION_GENERATION_FAILED')
        FROM game_location_travel_preparations p,game_story_turns t,npc_ai_jobs j
        WHERE r.campaign_id=$1 AND p.campaign_id=r.campaign_id AND p.id=r.id AND p.state='accepted'
        AND t.id=r.id AND t.decision_request_id=r.id AND t.erased_at IS NULL
        AND r.status='scheduled' AND j.id=r.job_id AND j.campaign_id=r.campaign_id
        AND j.purpose='story_turn' AND j.npc_id=t.actor_id
        AND (j.operation_id=r.id OR j.request_meta->>'runtimeRequestId'=r.id::text)
        AND j.status IN ('stale','failed','cancelled') RETURNING r.id,r.result_code
      ), marked AS (
        UPDATE game_location_travel_preparations p SET state='failed' FROM terminal
        WHERE p.id=terminal.id RETURNING p.id
      ) UPDATE game_story_turns t SET result_code=terminal.result_code
        FROM terminal,marked WHERE t.id=terminal.id AND marked.id=t.id AND t.status='committed'`,
      [id],
    );
  }
  private async reconcile(id: string, tick: number) {
    await this.reconcileTerminalTravel(id);
    await this.db.query(
      `UPDATE game_story_turns t SET result_code=COALESCE(r.result_code,'LOCATION_GENERATION_FAILED')
      FROM game_npc_decision_requests r,game_location_travel_preparations p
      WHERE t.campaign_id=$1 AND t.id=r.id AND p.id=t.id AND t.erased_at IS NULL
      AND t.status='committed' AND r.status IN ('failed','cancelled') AND p.state<>'committed'`,
      [id],
    );

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
      turn &&
      (!input.turnFence ||
        !matchesTurnFence(state, input.turnFence) ||
        turn.phase !== 'player' ||
        turn.activeActorId !== actorId ||
        turn.pendingResolution)
    )
      fail(409, 'STALE_STATE', 'STALE_STATE');
    if (input.expectedCanonRevision !== (state.narrativeCanon?.revision ?? 0))
      fail(409, 'STALE_CANON', 'STALE_CANON');
    const parsed = parseStorySegments(input.text);
    if (parsed.code) throw new Error(parsed.code);
    if (
      !turn &&
      !(
        input.channel === 'say' &&
        !input.targetNpcId &&
        parsed.segments.length === 1 &&
        parsed.segments[0].kind === 'attempt' &&
        resolveTravelRequest(state, parsed.segments[0].text)?.mapId
      )
    )
      throw new Error('WRONG_MODE');
    const directorOwned =
      storyTurnMode(input) === 'director' &&
      parsed.segments.some((segment) => segment.kind === 'attempt');
    // A deferred semantic beat owns the whole ordered attempt sequence. Applying a
    // later pickup/travel now would change witnesses or visibility before that beat.
    const deferAllAttempts =
      directorOwned &&
      (parsed.segments.some((segment) => segment.kind === 'speech') ||
        parsed.segments.some((segment) => {
          if (segment.kind !== 'attempt') return false;
          const action = parsePlayerTextAction(state, actorId, segment.text);
          return !action || isNpcStoryContact(state, action);
        }));
    const privateAudience = storyPrivateAudience(actorId, input);
    const areaWhisper = directorOwned && input.channel === 'whisper' && !input.targetNpcId;
    if (
      input.channel === 'whisper' &&
      !input.targetNpcId &&
      !directorOwned &&
      !this.port.prepareAreaTurnSpeech
    )
      throw new Error('PRIVATE_STORY_EXTENSION');
    if (
      directorOwned &&
      input.targetNpcId &&
      !storyImpactContext(state, actorId).some((target) => target.targetId === input.targetNpcId)
    )
      throw new Error('TARGET_UNAVAILABLE');
    let next = structuredClone(state);
    const entries: StorySafeEntry[] = [],
      requests: NpcDecisionRequest[] = [],
      actions: StoryActionPreview[] = [];
    const committedAttackOutcomes: StoryAttackOutcome[] = [];
    const untrustedRoleplay: {
      actorId: string;
      segmentIndex: number;
      text: string;
      verified: false;
    }[] = [];
    const roleplayAudiences = new Map<number, string[]>();
    const pendingSources: {
      actorId: string;
      text: string;
      channel: 'say' | 'whisper';
      identity: { turnId: string; segmentIndex: number };
    }[] = [];
    const hasSpeech = parsed.segments.some((segment) => segment.kind === 'speech');
    const listeners = (s: GameState) =>
      Object.values(s.entities)
        .filter((e) => ['npc', 'player'].includes(e.kind) && canNpcHear(s, e, s.entities[actorId]))
        .map((e) => e.id)
        .sort();
    for (const segment of parsed.segments) {
      if (segment.kind === 'attempt') {
        const parsedAction = parsePlayerTextAction(next, actorId, segment.text);
        const action = deferAllAttempts ? null : parsedAction;
        if (!action) {
          // Free-form RP is attributed player intent, never an authoritative action.
          // Do not fabricate inventory, payment, damage, movement or a success outcome.
          untrustedRoleplay.push({
            actorId,
            segmentIndex: segment.index,
            text: segment.text,
            verified: false,
          });
          const audienceIds = directorOwned
            ? [actorId]
            : (privateAudience ?? npcRoleplayObserverIds(next, actorId, input));
          roleplayAudiences.set(segment.index, audienceIds);
          const observed = !directorOwned
            ? this.port.prepareAreaTurnSpeech?.(
                next,
                actorId,
                {
                  channel: input.channel,
                  text: segment.text,
                  replyLocale: input.replyLocale,
                  presentationKind: 'attempt',
                  // Mixed prose already has reply jobs. Admit the gesture to actual
                  // observers without charging a second reply for each emote.
                  observeOnly: hasSpeech,
                },
                userId,
                { turnId, segmentIndex: segment.index },
              )
            : undefined;
          if (observed) {
            next = observed.state;
            requests.push(...observed.requests);
          }
          entries.push({
            ordinal: entries.length,
            tick: next.tick,
            kind: 'attempt',
            channel: input.channel,
            authorId: actorId,
            authorLabel: next.entities[actorId].label,
            text: segment.text,
            audienceIds,
            ...(observed?.sourceId ? { sourceId: observed.sourceId } : {}),
          });
          continue;
        }
        // Putting an already carried object into a pocket changes its presentation,
        // not custody. Do not fail it or charge a second item action.
        const alreadyCarried =
          action.kind === 'pick_up' &&
          action.targetId &&
          next.entities[action.targetId]?.ownerId === actorId &&
          next.entities[actorId].inventory?.includes(action.targetId);
        const applied = alreadyCarried
          ? { state: next, events: [] }
          : turn
            ? applyTurnAction(next, actorId, action, input.turnFence!)
            : applyAction(next, actorId, action);
        actions.push({
          segmentIndex: segment.index,
          action: action as NonNullable<StoryFeedEntry['action']>,
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
        if (!applied.error)
          next = recordNpcEvents(
            next,
            applied.state,
            applied.events,
            `turn:${turnId}:${segment.index}`,
          ).state;
        const outcomeCode = storyContactOutcomeCode(applied);
        if (action.kind === 'hit' || action.kind === 'push')
          committedAttackOutcomes.push({
            segmentIndex: segment.index,
            kind: action.kind,
            targetId: action.targetId!,
            code: outcomeCode,
          });
        entries.push({
          ordinal: entries.length,
          tick: next.tick,
          kind: 'outcome',
          channel: input.channel,
          code: outcomeCode,
          action: action as NonNullable<StoryFeedEntry['action']>,
          audienceIds: input.channel === 'whisper' ? [actorId] : listeners(next),
        });
      } else if (directorOwned && !areaWhisper) {
        // Earlier unresolved actions can change location, hearing and lifecycle.
        // Publish only after the ordered admission stamps the actual audience.
        const audienceIds = [actorId];
        entries.push({
          ordinal: entries.length,
          tick: next.tick,
          kind: 'speech',
          channel: input.channel,
          authorId: actorId,
          authorLabel: next.entities[actorId].label,
          text: segment.text,
          audienceIds,
          speakerKnownToIds: audienceIds.filter(
            (id) => id === actorId || npcRoleplayObserverIds(next, actorId, input).includes(id),
          ),
        });
      } else if (areaWhisper && this.port.prepareAreaTurnSpeech) {
        const identity = { turnId, segmentIndex: segment.index };
        pendingSources.push({ actorId, text: segment.text, channel: input.channel, identity });
        const preview = this.port.prepareAreaTurnSpeech(
          next,
          actorId,
          { channel: input.channel, text: segment.text, replyLocale: input.replyLocale },
          userId,
          identity,
        );
        for (const request of preview.requests) {
          const reference = preview.state.turnController!.deferredSpeech.find(
            (ref) => ref.id === request.id,
          )!;
          next.turnController!.deferredSpeech.push({ ...reference, pendingStoryTurnId: turnId });
          requests.push({
            ...request,
            context: {
              ...request.context,
              awaitStoryDirector: turnId,
              pendingStorySpeech: { sources: structuredClone(pendingSources), reference },
            },
          });
        }
        next.turnController!.nextSpeechSequence = preview.state.turnController!.nextSpeechSequence;
        if (preview.requests.length) next.revision++;
        entries.push({
          ordinal: entries.length,
          tick: next.tick,
          kind: 'speech',
          channel: input.channel,
          authorId: actorId,
          authorLabel: next.entities[actorId].label,
          text: segment.text,
          audienceIds: [actorId],
          speakerKnownToIds: [actorId],
        });
      } else if (this.port.prepareAreaTurnSpeech) {
        const spoken = this.port.prepareAreaTurnSpeech(
          next,
          actorId,
          { channel: input.channel, text: segment.text, replyLocale: input.replyLocale },
          userId,
          { turnId, segmentIndex: segment.index },
        );
        next = spoken.state;
        requests.push(...spoken.requests);
        entries.push({
          ordinal: entries.length,
          tick: next.tick,
          kind: 'speech',
          channel: input.channel,
          authorId: actorId,
          authorLabel: next.entities[actorId].label,
          text: segment.text,
          audienceIds: spoken.audienceIds,
          speakerKnownToIds: [
            ...(next.npcUtterances?.find((u) => u.id === spoken.sourceId)?.speakerKnownToIds ?? []),
          ],
          ...(spoken.sourceId ? { sourceId: spoken.sourceId } : {}),
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
          speakerKnownToIds: [
            ...(next.npcUtterances?.find((u) => u.id === spoken.sourceId)?.speakerKnownToIds ?? []),
          ],
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
    if (
      untrustedRoleplay.length &&
      !directorOwned &&
      !this.port?.prepareAreaTurnSpeech &&
      input.targetNpcId &&
      !requests.length
    ) {
      // An emote-only post may invite one NPC reply. It is recorded explicitly as
      // unverified attributed narrative, not as a completed physical event.
      const hash = digest({ turnId, roleplay: true });
      const requestId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
      const spoken = this.port.prepareTurnSpeech(
        next,
        actorId,
        input.targetNpcId,
        {
          channel: input.channel,
          text: untrustedRoleplay.map((entry) => entry.text).join('; '),
          presentationKind: 'attempt',
          replyLocale: input.replyLocale,
        },
        requestId,
        userId,
        { turnId, segmentIndex: untrustedRoleplay[0].segmentIndex },
      );
      next = spoken.state;
      requests.push(spoken.request);
      if (spoken.sourceId) {
        const entry = entries.find((value) => value.kind === 'attempt');
        if (entry) entry.sourceId = spoken.sourceId;
      }
    }
    if (areaWhisper)
      for (const request of requests)
        request.context = { ...request.context, awaitStoryDirector: turnId };
    if (untrustedRoleplay.length)
      for (const request of requests) {
        const observedRoleplay = untrustedRoleplay.filter((entry) =>
          roleplayAudiences.get(entry.segmentIndex)?.includes(request.npcId),
        );
        if (!observedRoleplay.length) continue;
        request.context = {
          ...request.context,
          untrustedRoleplay: observedRoleplay.map((entry) => {
            const observation = next.npcBrains?.[request.npcId]?.living?.observations.find(
              (o) =>
                o.kind === 'attempted' &&
                o.text === entry.text &&
                o.speechIdentity?.turnId === turnId &&
                o.speechIdentity.segmentIndex === entry.segmentIndex,
            );
            return { ...entry, ...(observation ? { observationId: observation.id } : {}) };
          }),
          roleplayPolicy:
            'Attributed player roleplay, in segment order. Respond naturally to harmless gestures, meals and services without requiring mechanical stock. These emotes alone do not mutate actual inventory, money, health or location; do not treat claimed damage or powers as validated mechanics.',
        };
      }
    if (directorOwned && deferAllAttempts)
      for (const [index, entry] of entries.entries())
        entry.sourceSegmentIndex = parsed.segments[index].index;
    return {
      state: next,
      entries,
      requests,
      actions,
      segments: parsed.segments,
      untrustedRoleplay,
      committedAttackOutcomes,
      speechAlreadyRecorded: false,
      directorText:
        (directorOwned || (!input.targetNpcId && input.channel !== 'whisper')) &&
        (directorOwned || !this.port?.prepareAreaTurnSpeech || untrustedRoleplay.length > 0)
          ? parsed.segments
              .flatMap((segment) =>
                segment.kind === 'speech'
                  ? [segment.text]
                  : untrustedRoleplay.some((entry) => entry.segmentIndex === segment.index)
                    ? [`*${segment.text.replaceAll('\\', '\\\\').replaceAll('*', '\\*')}*`]
                    : [],
              )
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
    const mode = storyTurnMode(input);
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
      const turnId = runtimeQuoteIdentity(`turn:${id}:${a.user.id}:${input.operationId}`);
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
      const quote: StoryQuote = {
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
      const quotedReplies: QuotedReply[] = [];
      // Posting mechanics is free. The complete world roster is prepared and
      // priced once after all players finish; never pre-sell an incomplete round.
      const confirmationHash = npcContextFingerprint(simulation.actions);
      const travel =
        input.channel === 'say' &&
        !input.targetNpcId &&
        simulation.segments.length === 1 &&
        simulation.segments[0].kind === 'attempt'
          ? resolveTravelRequest(live.state, simulation.segments[0].text)
          : null;
      const response: StoryTurnQuoteResponse = {
        status: 'quoted',
        operationId: input.operationId,
        turnId,
        mode,
        segments: simulation.segments,
        actionPreview: simulation.actions,
        confirmationHash,
        ...(travel && !travel.ambiguous
          ? {
              travel: {
                destinationName: travel.destinationName,
                generationRequired: !travel.mapId,
              },
            }
          : {}),
        quote,
      };
      const context = {
        generationPolicy: 'world-batch-v1',
        turnBased: !!live.state.turnController,
        localTravel: !live.state.turnController,
        ...(travel && !travel.mapId
          ? { travelOriginMapId: live.state.entities[a.actorId].mapId }
          : {}),
        replyLocale: input.replyLocale,
        stateHash: digest(live.state),
        turnFence: turnFence(live.state),
        confirmationHash,
        directorText: simulation.directorText,
        committedAttackOutcomes: simulation.committedAttackOutcomes,
        npcRepliesHandled: simulation.requests.length > 0,
        speechAlreadyRecorded: simulation.speechAlreadyRecorded,
        ...(simulation.untrustedRoleplay.length
          ? {
              untrustedRoleplay: simulation.untrustedRoleplay,
              roleplayPolicy:
                'Player-authored RP, not a mechanical action or validated inventory, money, damage or movement change. Harmless everyday roleplay can continue naturally.',
            }
          : {}),
        quotedReplies,
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
        const quotedReplies = r.context.quotedReplies as QuotedReply[] | undefined;
        if (quotedReplies?.length) {
          for (const reply of quotedReplies) await insertNpcRequest(c, id, reply.request);
        } else
          for (const request of simulation.requests)
            await insertNpcRequest(c, id, {
              ...request,
              context: { ...request.context, generationPolicy: r.context.generationPolicy },
            });
        if (simulation.directorText && !quotedReplies?.length) {
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
              generationPolicy: r.context.generationPolicy,
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
      const localSegments = parseStorySegments(input.text).segments;
      const requestedTravels =
        !input.targetNpcId && input.channel === 'say'
          ? localSegments.flatMap((segment) => {
              const request =
                segment.kind === 'attempt' ? resolveTravelRequest(live.state, segment.text) : null;
              return request ? [request] : [];
            })
          : [];
      if (
        !live.state.turnController &&
        (requestedTravels.length > 1 || requestedTravels.some((request) => request.ambiguous))
      )
        return {
          status: 'clarification',
          operationId: input.operationId,
          mode: 'director',
          segments: localSegments,
          actionPreview: [],
          code: 'AMBIGUOUS',
        };
      const localTravel =
        input.channel === 'say' &&
        !input.targetNpcId &&
        localSegments.length === 1 &&
        localSegments[0].kind === 'attempt' &&
        resolveTravelRequest(live.state, localSegments[0].text)?.mapId;
      if (live.state.turnController || localTravel) return this.quoteTurnBased(id, a, live, input);
      // Legacy realtime has no combined image+text consent. Never sell text that cannot finish an illustrated arrival.
      if (
        !input.targetNpcId &&
        input.channel === 'say' &&
        localSegments.some((segment) => {
          const request =
            segment.kind === 'attempt' ? resolveTravelRequest(live.state, segment.text) : null;
          return request && !request.mapId && !request.ambiguous;
        })
      )
        return {
          status: 'clarification',
          operationId: input.operationId,
          mode: 'director',
          segments: localSegments,
          actionPreview: [],
          code: 'LOCATION_GENERATION_REQUIRES_TURNS',
        };

      if (live.state.rulesetVersion !== 'hybrid-v3')
        fail(409, 'NARRATIVE_RULESET_REQUIRED', 'NARRATIVE_RULESET_REQUIRED');
      const parsed = parseStorySegments(input.text),
        mode = storyTurnMode(input);
      if (
        parsed.code ||
        (input.channel === 'whisper' &&
          !input.targetNpcId &&
          !parsed.segments.some((segment) => segment.kind === 'attempt'))
      )
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
        const turnId = runtimeQuoteIdentity(`turn:${id}:${a.user.id}:${input.operationId}`);
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
          c,
        );
        if (
          stored.budgetExceeded ||
          (!this.ai.contextWindow() &&
            Buffer.byteLength(JSON.stringify(stored)) > this.ai.contextBudgetBytes()) ||
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
      if ((live.state.turnController && r.context.turnBased) || r.context.localTravel)
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
  async replyQuote(
    req: Request,
    id: string,
    turnId: string,
    body: unknown,
  ): Promise<StoryTurnQuoteResponse> {
    const input = z.object({ operationId: z.uuid() }).strict().parse(body);
    return this.port.serial(id, async () => {
      const a = await this.port.access(req, id),
        live = await this.port.load(id);
      const turn = await this.row(id, turnId, a.user.id);
      if (!turn || turn.erased_at || turn.status !== 'committed' || !this.ai.releaseGeneration())
        fail(404, 'NOT_FOUND', 'NOT_FOUND');
      if (live.state.turnController?.phase !== 'world')
        fail(409, 'TURN_PHASE_STALE', 'TURN_PHASE_STALE');
      if (turn.context.replyRecovery?.operationId === input.operationId)
        return turn.context.replyRecovery.response;
      const pending = await this.db.query(
        `SELECT r.* FROM game_npc_decision_requests r WHERE r.campaign_id=$1 AND r.requester_user_id=$2 AND r.context->>'storyTurnId'=$3 AND r.status='queued' AND r.result_code='GENERATION_QUOTE_STALE' AND r.job_id IS NULL
          AND NOT EXISTS(SELECT 1 FROM npc_ai_jobs j WHERE j.operation_id=r.id OR j.request_meta->>'runtimeRequestId'=r.id::text)
          AND NOT EXISTS(SELECT 1 FROM live_test_text_permits p WHERE p.request_id=r.id)
          AND NOT EXISTS(SELECT 1 FROM generation_budget_reservations b WHERE b.operation_key='manual-text:'||r.id::text)
          AND NOT EXISTS(SELECT 1 FROM spark_holds h WHERE h.source_id=r.id::text)
          ORDER BY r.created_at,r.id`,
        [id, a.user.id, turnId],
      );
      if (!pending.length) fail(409, 'LIVE_REQUEST_UNAVAILABLE', 'LIVE_REQUEST_UNAVAILABLE');
      return this.db.tx(async (c) => {
        await this.authorized(c, id, a.user.id);
        const replies: QuotedReply[] = [];
        for (const old of pending) {
          const request: NpcDecisionRequest = {
            id: old.id,
            npcId: old.npc_id,
            purpose: old.purpose,
            causeKey: old.cause_key,
            requesterUserId: a.user.id,
            recipientActorId: old.recipient_actor_id,
            context: old.context,
          };
          let context: DecisionContext;
          if (request.purpose === 'speech') {
            context = await extendContextHistory(
              this.db,
              this.ai,
              id,
              live.state,
              a.actorId,
              this.port.deferredSpeechContext(live.state, request),
              'speech',
              request.npcId,
            );
          } else if (request.purpose === 'story_turn') {
            const worldInput = {
              ...turn.input,
              text: turn.context.directorText,
              expectedCanonRevision: live.state.narrativeCanon?.revision ?? 0,
              turnFence: turnFence(live.state),
            };
            const base = buildStoryTurnContext(live.state, a.actorId, worldInput, turnId);
            context = await extendContextHistory(
              this.db,
              this.ai,
              id,
              live.state,
              a.actorId,
              {
                ...base,
                turnBased: true,
                turnBasedDeferredDirector: true,
                worldInput,
                storyTurnId: turnId,
                npcRepliesHandled: turn.context.npcRepliesHandled === true,
                speechAlreadyRecorded: turn.context.speechAlreadyRecorded === true,
                directorText: turn.context.directorText,
                committedAttackOutcomes: turn.context.committedAttackOutcomes ?? [],
                ...(turn.context.untrustedRoleplay
                  ? {
                      untrustedRoleplay: turn.context.untrustedRoleplay,
                      roleplayPolicy: turn.context.roleplayPolicy,
                    }
                  : {}),
                turnFence: turnFence(live.state),
                mockProposal: createMockStoryTurnProposal(
                  live.state,
                  a.actorId,
                  worldInput,
                  turnId,
                ),
              },
              'story_turn',
              undefined,
              c,
            );
          } else fail(409, 'LIVE_REQUEST_UNAVAILABLE', 'LIVE_REQUEST_UNAVAILABLE');
          const quote = await this.ai.quote(
            {
              campaignId: id,
              npcId: request.npcId,
              subjectKind: request.purpose === 'story_turn' ? 'player' : 'npc',
              origin: 'user',
              purpose: request.purpose,
              requesterUserId: a.user.id,
            },
            context!,
            a.user.id,
            c,
          );
          replies.push({ request: { ...request, context: context! }, quote });
        }
        const response: StoryTurnQuoteResponse = {
          status: 'quoted',
          turnId,
          operationId: input.operationId,
          mode: storyTurnMode(turn.input),
          segments: [],
          actionPreview: [],
          quote: aggregateReplyQuote(randomUUID(), replies),
        };
        const recovery = {
          operationId: input.operationId,
          stateHash: digest(live.state),
          response,
          replies,
        };
        await c.query(
          "UPDATE game_story_turns SET context=jsonb_set(context,'{replyRecovery}',$2::jsonb) WHERE id=$1",
          [turnId, JSON.stringify(recovery)],
        );
        return response;
      });
    });
  }
  async replyConsent(req: Request, id: string, turnId: string, body: unknown) {
    const input = z
      .object({ operationId: z.uuid(), quoteId: z.uuid(), consent: z.literal(true) })
      .strict()
      .parse(body);
    return this.port.serial(id, async () => {
      const a = await this.port.access(req, id),
        live = await this.port.load(id);
      const turn = await this.row(id, turnId, a.user.id);
      if (!turn || turn.erased_at || !this.ai.releaseGeneration())
        fail(404, 'NOT_FOUND', 'NOT_FOUND');
      const recovery = turn.context.replyRecovery;
      if (
        !recovery ||
        recovery.operationId !== input.operationId ||
        recovery.response.quote.id !== input.quoteId
      )
        fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
      if (recovery.accepted) return this.receipt(turn);
      if (turn.status !== 'committed')
        fail(409, 'LIVE_REQUEST_UNAVAILABLE', 'LIVE_REQUEST_UNAVAILABLE');
      if (
        recovery.stateHash !== digest(live.state) ||
        Date.parse(recovery.response.quote.expiresAt) <= Date.now()
      )
        fail(409, 'QUOTE_EXPIRED', 'QUOTE_EXPIRED');
      await this.db.tx(async (c) => {
        await this.authorized(c, id, a.user.id);
        const replies = recovery.replies as QuotedReply[];
        for (const reply of replies) {
          const updated = await c.query(
            `UPDATE game_npc_decision_requests r SET context=$2,result_code=NULL WHERE r.id=$1 AND r.campaign_id=$3 AND r.requester_user_id=$4 AND r.status='queued' AND r.result_code='GENERATION_QUOTE_STALE' AND r.job_id IS NULL
            AND NOT EXISTS(SELECT 1 FROM npc_ai_jobs j WHERE j.operation_id=r.id OR j.request_meta->>'runtimeRequestId'=r.id::text)
            AND NOT EXISTS(SELECT 1 FROM live_test_text_permits p WHERE p.request_id=r.id)
            AND NOT EXISTS(SELECT 1 FROM generation_budget_reservations b WHERE b.operation_key='manual-text:'||r.id::text)
            AND NOT EXISTS(SELECT 1 FROM spark_holds h WHERE h.source_id=r.id::text)
            RETURNING r.id`,
            [reply.request.id, JSON.stringify(reply.request.context), id, a.user.id],
          );
          if (!updated.rowCount) fail(409, 'LIVE_REQUEST_UNAVAILABLE', 'LIVE_REQUEST_UNAVAILABLE');
        }
        const replaceIds = new Set(replies.map((reply) => reply.request.id));
        const quotedReplies = [
          ...((turn.context.quotedReplies as QuotedReply[] | undefined) ?? []).filter(
            (reply) => !replaceIds.has(reply.request.id),
          ),
          ...replies,
        ];
        await c.query('UPDATE game_story_turns SET context=$2 WHERE id=$1', [
          turnId,
          JSON.stringify({
            ...turn.context,
            quotedReplies,
            replyRecovery: { ...recovery, accepted: true },
          }),
        ]);
      });
      live.decisionsPending = true;
      return this.receipt((await this.row(id, turnId, a.user.id))!);
    });
  }
  /** Build every new-policy request against the actual world-entry state, before pricing. */
  async prepareWorldRequests(id: string, live: StoryLive) {
    if (live.state.turnController?.phase !== 'world') return;
    const rows = await this.db.query(
      "SELECT * FROM game_npc_decision_requests WHERE campaign_id=$1 AND status='queued' AND job_id IS NULL AND context->>'generationPolicy'='world-batch-v1' AND NOT(context ? 'worldPrepared') ORDER BY created_at,id",
      [id],
    );
    for (const request of rows) {
      const turnId = request.context.storyTurnId ?? request.id;
      const turn = await this.row(id, turnId);
      if (!turn || turn.erased_at || turn.status !== 'committed') continue;
      let context: DecisionContext;
      if (request.purpose === 'speech') {
        const speaker = live.state.entities[turn.actor_id];
        const recipient = live.state.entities[request.npc_id];
        if (
          !speaker ||
          !recipient ||
          !isActorConscious(recipient) ||
          speaker.mapId !== recipient.mapId
        ) {
          // Keep the original heard memory, but do not generate a reply across maps
          // or construct a raster spanning the departed speaker and this NPC.
          // The financial-evidence guard refuses to terminalize already-paid work;
          // advanceTurnWorld drains only terminal request markers afterwards.
          await this.port.failWorldRequest(id, request.id, 'SPEECH_PARTICIPANT_DEPARTED');
          continue;
        }
        let base: DecisionContext;
        try {
          base = this.port.deferredSpeechContext(live.state, {
            id: request.id,
            npcId: request.npc_id,
            purpose: 'speech',
            causeKey: request.cause_key,
            requesterUserId: request.requester_user_id,
            context: request.context,
          });
        } catch (error) {
          const code = error instanceof Error ? error.message : '';
          if (!['STALE_STATE', 'OUT_OF_RANGE', 'TARGET_UNAVAILABLE', 'FORBIDDEN'].includes(code))
            throw error;
          // A new outgoing audience may not be allowed to hear the incoming
          // whisper. Stay silent; never broaden disclosure or strand the roster.
          await this.port.failWorldRequest(id, request.id, 'NO_SAFE_RESPONSE');
          continue;
        }
        context = await extendContextHistory(
          this.db,
          this.ai,
          id,
          live.state,
          turn.actor_id,
          {
            ...base,
            generationPolicy: 'world-batch-v1',
            worldPrepared: true,
            worldRequesterId: turn.requester_user_id,
          },
          'speech',
          request.npc_id,
        );
      } else if (request.purpose === 'story_turn') {
        if (
          turn.context.travelOriginMapId &&
          turn.context.travelOriginMapId !== live.state.entities[turn.actor_id]?.mapId
        ) {
          await this.port.failWorldRequest(id, request.id, 'TRAVEL_ORIGIN_CHANGED');
          continue;
        }
        const worldInput = {
          ...turn.input,
          text: turn.context.directorText,
          expectedCanonRevision: live.state.narrativeCanon?.revision ?? 0,
          turnFence: turnFence(live.state)!,
        };
        const base = buildStoryTurnContext(live.state, turn.actor_id, worldInput, turn.id);
        context = await extendContextHistory(
          this.db,
          this.ai,
          id,
          live.state,
          turn.actor_id,
          {
            ...base,
            worldInput,
            turnBasedDeferredDirector: true,
            turnBased: true,
            storyTurnId: turn.id,
            generationPolicy: 'world-batch-v1',
            worldPrepared: true,
            worldRequesterId: turn.requester_user_id,
            turnFence: turnFence(live.state),
            npcRepliesHandled: turn.context.npcRepliesHandled === true,
            ...(turn.context.semanticTravelIntent
              ? { semanticTravelIntent: turn.context.semanticTravelIntent }
              : {}),
            speechAlreadyRecorded: turn.context.speechAlreadyRecorded === true,
            committedAttackOutcomes: turn.context.committedAttackOutcomes ?? [],
            ...(turn.context.untrustedRoleplay?.length
              ? {
                  untrustedRoleplay: turn.context.untrustedRoleplay,
                  roleplayPolicy: turn.context.roleplayPolicy,
                }
              : {}),
            mockProposal: createMockStoryTurnProposal(
              live.state,
              turn.actor_id,
              worldInput,
              turn.id,
            ),
          },
          'story_turn',
        );
      } else continue;
      await this.db.tx(async (c) => {
        await c.query(
          "UPDATE game_npc_decision_requests SET context=$2 WHERE id=$1 AND status='queued' AND job_id IS NULL AND NOT(context ? 'worldPrepared')",
          [request.id, JSON.stringify(context)],
        );
        if (request.purpose === 'story_turn')
          await c.query(
            'UPDATE game_story_turns SET context=$2 WHERE id=$1 AND erased_at IS NULL',
            [turn.id, JSON.stringify({ ...turn.context, ...context })],
          );
      });
    }
  }
  /** Upgrade only proven-unpaid pre-composer requests; never reset a permit or provider outcome. */
  async requireLegacyReplyConsent(campaignId: string, request: Row) {
    if (
      !this.ai.releaseGeneration() ||
      request.job_id ||
      request.context?.generationPolicy === 'world-batch-v1' ||
      !request.requester_user_id ||
      !['speech', 'story_turn'].includes(request.purpose)
    )
      return false;
    const rows = await this.db.query(
      `UPDATE game_npc_decision_requests r SET result_code='GENERATION_QUOTE_STALE',
       context=jsonb_set(r.context,'{storyTurnId}',to_jsonb(t.id::text))
       FROM game_story_turns t WHERE r.id=$1 AND r.campaign_id=$2 AND r.status='queued' AND r.job_id IS NULL
       AND t.id::text=COALESCE(r.context->>'storyTurnId',r.id::text) AND t.campaign_id=r.campaign_id
       AND t.requester_user_id=r.requester_user_id AND t.status='committed' AND t.erased_at IS NULL
       AND t.context->>'turnBased'='true' AND NOT COALESCE(jsonb_array_length(t.context->'quotedReplies')>0,false)
       AND NOT EXISTS(SELECT 1 FROM live_test_text_permits p WHERE p.request_id=r.id)
       AND NOT EXISTS(SELECT 1 FROM npc_ai_jobs j WHERE j.operation_id=r.id OR j.request_meta->>'runtimeRequestId'=r.id::text)
       AND NOT EXISTS(SELECT 1 FROM generation_budget_reservations b WHERE b.operation_key='manual-text:'||r.id::text)
       AND NOT EXISTS(SELECT 1 FROM spark_holds h WHERE h.source_id=r.id::text)
       RETURNING r.id`,
      [request.id, campaignId],
    );
    return rows.length > 0;
  }
  async quotedReply(campaignId: string, request: Row): Promise<QuotedReply | null> {
    const turnId = request.context?.storyTurnId;
    if (typeof turnId !== 'string' || !this.ai.releaseGeneration()) return null;
    const turn = await this.row(campaignId, turnId, request.requester_user_id);
    if (!turn || turn.erased_at || turn.status !== 'committed') return null;
    const reply = (turn.context.quotedReplies as QuotedReply[] | undefined)?.find(
      (value) =>
        value.request.id === request.id &&
        value.request.npcId === request.npc_id &&
        value.request.purpose === request.purpose &&
        value.request.requesterUserId === request.requester_user_id,
    );
    return reply && digest(reply.request.context) === digest(request.context) ? reply : null;
  }
  async schedule(id: string, live: StoryLive, request: Row, worldReply?: QuotedReply | null) {
    const r = await this.row(id, request.id);
    if (r?.context.turnBased && r.context.directorText && request.context.turnBasedDeferredDirector)
      return this.scheduleTurnDirector(id, live, request, r, worldReply);
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
  private async scheduleTurnDirector(
    id: string,
    live: StoryLive,
    request: Row,
    r: Row,
    worldReply?: QuotedReply | null,
  ) {
    if (live.state.turnController?.phase !== 'world') return;
    if (request.result_code === 'GENERATION_QUOTE_STALE') return;
    const frozenReply = worldReply ?? (await this.quotedReply(id, request));
    if (frozenReply) {
      try {
        const context = frozenReply.request.context;
        const compatibleTravel = await this.port.canUseFrozenTravel?.(id, r.id);
        const current = buildStoryTurnContext(
          live.state,
          r.actor_id,
          compatibleTravel
            ? {
                ...(context.worldInput as StoryTurnInput),
                expectedCanonRevision: live.state.narrativeCanon?.revision ?? 0,
              }
            : (context.worldInput as StoryTurnInput),
          r.id,
        );
        if (
          (current.contextHash !== context.contextHash && !compatibleTravel) ||
          !matchesTurnFence(live.state, context.turnFence)
        )
          fail(409, 'STALE_STATE', 'STALE_STATE');
        // Persist result-application evidence BEFORE queue can commit a job/hold.
        // A restart after native admission must never see the original mechanical context.
        await this.db.query(
          'UPDATE game_story_turns SET context=$2 WHERE id=$1 AND erased_at IS NULL',
          [
            r.id,
            JSON.stringify({ ...r.context, ...context, quotedReplies: r.context.quotedReplies }),
          ],
        );
        await this.ai.queue({
          scope: {
            campaignId: id,
            npcId: r.actor_id,
            subjectKind: 'player',
            origin: 'user',
            purpose: 'story_turn',
            requesterUserId: request.requester_user_id,
          },
          requesterUserId: request.requester_user_id,
          operationId: r.id,
          quoteId: frozenReply.quote.id,
          consent: true,
          context,
          requestKey: `turn-director:${r.id}`,
          runtimeRequestId: r.id,
          expectedRuntimeContextDigest: digest(context),
          ...(worldReply?.batchId ? { acceptedWorldBatchId: worldReply.batchId } : {}),
        });
        live.aiPending = true;
        this.port.dispatch(id);
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        if (code.includes('NPC_AI_BUSY') || code.includes('RATE_LIMITED')) return;
        if (worldReply && request.context.generationPolicy === 'world-batch-v1') {
          await this.port.failWorldRequest(id, request.id, 'WORLD_ADMISSION_FAILED');
          return;
        }
        await this.db.query(
          "UPDATE game_npc_decision_requests SET result_code='GENERATION_QUOTE_STALE' WHERE id=$1 AND status='queued'",
          [request.id],
        );
      }
      return;
    }
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
                committedAttackOutcomes: r.context.committedAttackOutcomes ?? [],
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
        speakerKnownToIds: [...(source.speakerKnownToIds ?? [])],
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
  /** Persist a continuation of a completed interpretation, never replay its original effects. */
  private async stageSemanticTravel(
    c: PoolClient,
    campaignId: string,
    source: Row,
    state: GameState,
    intent: NonNullable<StoryTurnProposal['travelIntent']>,
    sourceJobId: string,
    sequence: number,
  ) {
    const childId = runtimeQuoteIdentity(`semantic-travel:${source.id}`);
    // Quoted destination syntax represents the already interpreted name, including conjunctions.
    const name = intent.destinationName.replace(/[«»]/gu, '');
    const text = `*go to «${name.replaceAll('\\', '\\\\').replaceAll('*', '\\*')}»*`;
    const input = storyTurnInputSchema.parse({
      operationId: childId,
      text,
      channel: 'say',
      replyLocale: source.input.replyLocale,
      expectedCanonRevision: state.narrativeCanon?.revision ?? 0,
      turnFence: turnFence(state),
    });
    const context = {
      generationPolicy: 'world-batch-v1',
      turnBased: true,
      turnBasedDeferredDirector: true,
      directorText: text,
      npcRepliesHandled: true,
      travelOriginMapId: state.entities[source.actor_id].mapId,
      semanticTravelIntent: { ...intent, destinationName: name },
      semanticTravelSourceTurnId: source.id,
      semanticTravelSourceJobId: sourceJobId,
    };
    await insertNpcRequest(c, campaignId, {
      id: childId,
      npcId: source.actor_id,
      purpose: 'story_turn',
      causeKey: `semantic-travel:${source.id}`,
      requesterUserId: source.requester_user_id,
      recipientActorId: source.actor_id,
      context: { ...context, contextHash: digest({ id: childId }), replyLocale: input.replyLocale },
    });
    await c.query(
      `INSERT INTO game_story_turns
      (id,campaign_id,requester_user_id,actor_id,operation_id,request_hash,input,segments,context,status,
       result_code,decision_request_id,submitted_sequence,committed_sequence,submitted_at,committed_at)
      VALUES($1,$2,$3,$4,$1,$5,$6,$7,$8,'committed','NPC_REPLY_DEFERRED',$1,$9,$9,now(),now())
      ON CONFLICT(id) DO NOTHING`,
      [
        childId,
        campaignId,
        source.requester_user_id,
        source.actor_id,
        digest(input),
        JSON.stringify(input),
        JSON.stringify(parseStorySegments(text).segments),
        JSON.stringify(context),
        sequence,
      ],
    );
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
      r.requester_user_id !==
        (job.context.generationPolicy === 'world-batch-v1'
          ? job.context.worldRequesterId
          : job.requesterUserId) ||
      r.context.contextHash !== job.contextHash
    ) {
      await this.db.tx((c) => this.ai.finalize(c, job.id, 'stale'));
      return;
    }
    const duplicateReply =
      (Boolean(job.context.travelSceneSpec) &&
        (Boolean((job.proposal as StoryTurnProposal)?.travelIntent) ||
          ((job.proposal as StoryTurnProposal)?.steps ?? []).some(
            (step) => step.narrativeImpact != null,
          ))) ||
      (job.context.npcRepliesHandled === true &&
        Array.isArray((job.proposal as { steps?: unknown[] } | null)?.steps) &&
        (job.proposal as { steps: { reply?: unknown; replyNpcId?: unknown }[] }).steps.some(
          (step) => step.reply != null || step.replyNpcId != null,
        ));
    const originalInput = deferredDirector ? r.context.worldInput : r.input;
    const rebasedTravel =
      job.context.travelSceneSpec &&
      (job.proposal as { contextHash?: string })?.contextHash === job.contextHash
        ? await this.port.rebaseTravel?.(id, r.id, live.state, originalInput, job.proposal)
        : null;
    const applied: ReturnType<typeof applyStoryTurnProposal> = duplicateReply
      ? {
          state: live.state,
          events: [],
          entries: [],
          actions: [],
          error: 'INVALID_ACTION' as const,
        }
      : applyStoryTurnProposal(
          live.state,
          r.actor_id,
          rebasedTravel?.input ?? originalInput,
          r.id,
          rebasedTravel?.proposal ?? job.proposal,
          {
            speechAlreadyRecorded: deferredDirector && r.context.speechAlreadyRecorded === true,
            ...(deferredDirector && r.input.channel === 'whisper' && !r.input.targetNpcId
              ? {
                  sourceSpeechSegments: parseStorySegments(r.input.text).segments.filter(
                    (segment) => segment.kind === 'speech',
                  ),
                }
              : {}),
          },
        );
    let travelFailure: string | undefined;
    let travelArt: ((c: PoolClient, state: GameState) => Promise<GameState>) | undefined;
    if (
      !applied.error &&
      !applied.clarification &&
      applied.actions.some((p) => p.action.kind === 'travel' && p.action.targetId === 'new_scene')
    ) {
      // Real arrivals need the exact already-consented image, not a placeholder map.
      if (!this.port.admitTravel) {
        applied.error = 'INVALID_ACTION';
      } else
        try {
          travelArt = await this.port.admitTravel(id, r.id, job.proposal as StoryTurnProposal);
        } catch (error) {
          travelFailure =
            (error as { getResponse?: () => { code?: string } }).getResponse?.().code ??
            'LOCATION_GENERATION_FAILED';
          applied.error = 'INVALID_ACTION';
        }
    }
    const requiresConfirmation =
      !deferredDirector &&
      !applied.error &&
      !applied.clarification &&
      applied.actions.some((preview) => !['pick_up', 'travel'].includes(preview.action.kind)) &&
      r.confirmed_action_hash !== npcContextFingerprint(applied.actions);
    const status = applied.error
      ? 'stale'
      : applied.clarification
        ? 'clarification'
        : requiresConfirmation
          ? 'awaiting_confirmation'
          : 'committed';
    const next = settlePendingStorySpeech(
      status === 'committed' ? applied.state : live.state,
      r.id,
    );
    const sequence = live.eventSeq + 1,
      proposalHash = digest({ turnId: r.id, contextHash: job.contextHash, proposal: job.proposal });
    const canon =
      status === 'committed' ? next.narrativeCanon?.turns.find((t) => t.id === r.id) : undefined;
    let pinFailure: string | undefined;
    try {
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
              travelFailure ?? applied.error ?? applied.clarification ?? null,
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
              travelFailure ?? applied.error ?? applied.clarification ?? null,
            ],
          );
          if (status === 'committed' && applied.pendingTravel) {
            await this.stageSemanticTravel(c, id, r, next, applied.pendingTravel, job.id, sequence);
            live.decisionsPending = true;
          }
          if (status === 'committed' && deferredDirector && !r.context.speechAlreadyRecorded)
            for (const entry of applied.entries.filter(
              (entry) => entry.kind === 'attempt' || (entry.kind === 'speech' && entry.sourceId),
            ))
              await c.query(
                `UPDATE game_story_feed SET entry=entry || $4::jsonb,audience_ids=$5::text[]
                WHERE id=(SELECT id FROM game_story_feed WHERE turn_id=$1 AND entry->>'kind'=$7
                  AND entry->>'authorId'=$2 AND entry->>'text'=$3
                  AND (entry->>'sourceSegmentIndex'=$6::text OR
                    (NOT(entry ? 'sourceSegmentIndex') AND NOT(entry ? 'sourceId')))
                  ORDER BY CASE WHEN entry->>'sourceSegmentIndex'=$6::text THEN 0 ELSE 1 END,
                    ordinal LIMIT 1)`,
                [
                  r.id,
                  entry.authorId,
                  entry.text,
                  JSON.stringify({
                    ...(entry.sourceId ? { sourceId: entry.sourceId } : {}),
                    sourceSegmentIndex: entry.sourceSegmentIndex,
                    speakerKnownToIds: entry.speakerKnownToIds ?? [],
                  }),
                  entry.audienceIds,
                  entry.sourceSegmentIndex,
                  entry.kind,
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
        status === 'committed' && travelArt
          ? async (c, state) => {
              try {
                return await travelArt(c, state);
              } catch (error) {
                const code = (
                  error as { getResponse?: () => { code?: string }; getStatus?: () => number }
                ).getResponse?.().code;
                if (code && ((error as { getStatus?: () => number }).getStatus?.() ?? 500) < 500)
                  pinFailure = code;
                throw error;
              }
            }
          : undefined,
      );
    } catch (error) {
      if (!pinFailure) throw error;
      // The rejected pin rolled back together with arrival. Finalize only that exact ready job;
      // keep known provider costs/holds and the original mechanical post intact.
      await this.db.tx(async (c) => {
        const locked = (
          await c.query(
            'SELECT status,job_id FROM game_npc_decision_requests WHERE id=$1 FOR UPDATE',
            [r.id],
          )
        ).rows[0];
        if (locked?.status !== 'scheduled' || locked.job_id !== job.id) return;
        await this.ai.finalize(c, job.id, 'stale');
        await c.query(
          "UPDATE game_npc_decision_requests SET status='failed',result_code=$2 WHERE id=$1",
          [r.id, pinFailure],
        );
        await c.query(
          'UPDATE game_story_turns SET result_code=$2 WHERE id=$1 AND erased_at IS NULL',
          [r.id, pinFailure],
        );
        await c.query(
          "UPDATE game_location_travel_preparations SET state='failed' WHERE id=$1 AND state='accepted'",
          [r.id],
        );
      });
    }
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
      for (const entry of entries) {
        const stored = entry as StoryFeedEntry & {
          sourceId?: string;
          sourceSegmentIndex?: number;
          speakerKnownToIds?: unknown;
        };
        if (
          ['speech', 'npc_reply'].includes(entry.kind) &&
          (!Array.isArray(stored.speakerKnownToIds) ||
            !stored.speakerKnownToIds.includes(a.actorId))
        ) {
          delete entry.authorId;
          delete entry.authorLabel;
        }
        delete stored.sourceId;
        delete stored.sourceSegmentIndex;
        delete stored.speakerKnownToIds;
      }
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
            // Legacy narrative rows have no immutable speaker-recognition evidence.
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
            channel: t.channel === 'whisper' ? 'whisper' : 'say',
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
        `SELECT t.*,tp.scene->>'name' AS travel_name,tp.state AS travel_state,r.status AS travel_request_status,ij.status AS travel_image_status,ih.status AS travel_spark_status,ih.reserved_subunits AS travel_spark_reserved,ih.captured_subunits AS travel_spark_captured,ih.sparks_reserved_subunits AS travel_spark_paid_reserved,EXISTS(SELECT 1 FROM game_npc_decision_requests pending WHERE pending.campaign_id=t.campaign_id AND pending.context->>'storyTurnId'=t.id::text AND pending.status='queued' AND pending.result_code='GENERATION_QUOTE_STALE') AS generation_needs_confirmation,j.status AS job_status,j.credits AS job_credits,sh.status AS spark_status,sh.reserved_subunits AS spark_reserved,sh.captured_subunits AS spark_captured,sh.sparks_reserved_subunits AS spark_paid_reserved FROM game_story_turns t LEFT JOIN game_location_travel_preparations tp ON tp.id=t.id LEFT JOIN image_generation_jobs ij ON ij.id=tp.image_job_id LEFT JOIN spark_holds ih ON ih.id=ij.spark_quote_id LEFT JOIN game_npc_decision_requests r ON r.id=t.decision_request_id LEFT JOIN npc_ai_jobs j ON j.id=r.job_id LEFT JOIN spark_holds sh ON sh.id=COALESCE(j.spark_hold_id,(SELECT br.spark_quote_id FROM live_test_text_permits p JOIN generation_budget_reservations br ON br.id=p.reservation_id WHERE p.job_id=j.id OR p.request_id::text=j.request_meta->>'runtimeRequestId' LIMIT 1)) WHERE t.campaign_id=$1 AND t.requester_user_id=$2 AND t.erased_at IS NULL AND t.status<>'quoted' ORDER BY t.created_at DESC LIMIT 40`,
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

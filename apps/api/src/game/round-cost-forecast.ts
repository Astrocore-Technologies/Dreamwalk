import { isActorConscious } from '@dreamwalk/contracts';
import { providerMicrosToSparkSubunits, type GameState } from '@dreamwalk/contracts';
import { buildNpcDecisionContext, buildStoryTurnContext, turnFence } from '@dreamwalk/game-core';
import type { Db } from '../db';
import type { NpcAiEngine } from '../ai/npc-ai.service';
import type { AiPurpose, DecisionContext } from '../ai/types';
import type { NpcDecisionRequest } from './npc-requests';

export interface WorldRoundForecast {
  basis: 'local_round_forecast';
  estimatedTotalMicros: number | null;
  estimatedSparkSubunits: string | null;
  requestCount: number;
  optionalAutonomousSpeechRequests: number;
  optionalAutonomousSpeechSparkSubunits: string | null;
  optionalAutonomousSpeechAllowanceSubunits: string | null;
  optionalAutonomousSpeechUnestimatedRequests: number;
  baseEstimatedSparkSubunits: string | null;
  includesMapAnalysis: false;
  finalQuoteRequired: true;
  unavailableReason?: 'pricing_unavailable' | 'context_unavailable';
}

/** A text-only preview of this round, not a quote, reservation, or spending limit.
 * Current-map NPCs consider their next action every round. Already-submitted
 * speech/director requests are included, but unsubmitted drafts never leave the UI.
 * No private IDs, observations, context, or cognition leave this server boundary. */
export async function forecastWorldRound(
  db: Pick<Db, 'query'>,
  ai: Pick<NpcAiEngine, 'localRequestForecast'> &
    Partial<Pick<NpcAiEngine, 'localAutonomousSpeechForecast' | 'localAutonomousSpeechAllowance'>>,
  campaignId: string,
  state: GameState,
  prepareSpeech?: (state: GameState, request: NpcDecisionRequest) => DecisionContext,
  prepareOptionalSpeech?: (state: GameState, npcId: string) => DecisionContext[],
): Promise<WorldRoundForecast | null> {
  const turn = state.turnController;
  if (!turn) return null;
  const rows = await db.query(
    `SELECT r.npc_id,r.purpose,r.status,r.context,r.id,r.cause_key,
       t.id AS turn_id,t.actor_id AS turn_actor_id,t.input AS turn_input,t.context AS turn_context
     FROM game_npc_decision_requests r
     LEFT JOIN game_story_turns t ON t.campaign_id=r.campaign_id
       AND t.id::text=COALESCE(r.context->>'storyTurnId',r.id::text)
     WHERE r.campaign_id=$1 AND (t.id IS NULL OR t.erased_at IS NULL)
       AND (r.context->'turnFence'->>'roundId'=$2
         OR (t.context->>'turnBased'='true' AND t.input->'turnFence'->>'roundId'=$2)
         OR r.id::text=ANY($3::text[]))`,
    [
      campaignId,
      turn.roundId,
      turn.deferredSpeech
        .filter((speech) => speech.roundId === turn.roundId)
        .map((speech) => speech.id),
    ],
  );
  let contextUnavailable = false;
  const requests: { npcId: string; purpose: AiPurpose; context: DecisionContext }[] = [];
  for (const row of rows) {
    if (
      row.status !== 'queued' ||
      !['plan', 'summary', 'speech', 'story_turn'].includes(row.purpose) ||
      row.context.offmapCompanionContinuation ||
      (row.context.storyTurnId &&
        !row.context.turnBased &&
        !row.context.deferredSpeechId &&
        row.context.generationPolicy !== 'world-batch-v1')
    )
      continue;
    let context: DecisionContext = row.context;
    try {
      if (row.purpose === 'speech' && row.context.deferredSpeechId && !row.context.claims) {
        if (!prepareSpeech) throw new Error('FORECAST_CONTEXT_UNAVAILABLE');
        // World preparation is simulated on an isolated copy only. It uses the
        // existing audience/disclosure builder without admitting any state change.
        const upcoming = structuredClone(state);
        upcoming.turnController!.phase = 'world';
        context = prepareSpeech(upcoming, {
          id: row.id,
          npcId: row.npc_id,
          purpose: 'speech',
          causeKey: row.cause_key,
          context: row.context,
        });
      } else if (
        row.purpose === 'story_turn' &&
        row.context.turnBasedDeferredDirector &&
        !row.context.worldPrepared &&
        !row.context.worldInput
      ) {
        if (
          !row.turn_input ||
          !row.turn_context?.directorText ||
          !row.turn_actor_id ||
          !row.turn_id
        )
          throw new Error('FORECAST_CONTEXT_UNAVAILABLE');
        const worldInput = {
          ...row.turn_input,
          text: row.turn_context.directorText,
          expectedCanonRevision: state.narrativeCanon?.revision ?? 0,
          turnFence: turnFence(state),
        };
        context = {
          ...buildStoryTurnContext(state, row.turn_actor_id, worldInput, row.turn_id),
          turnBased: true,
          turnBasedDeferredDirector: true,
          npcRepliesHandled: row.turn_context.npcRepliesHandled === true,
          speechAlreadyRecorded: row.turn_context.speechAlreadyRecorded === true,
          worldInput,
          committedAttackOutcomes: row.turn_context.committedAttackOutcomes ?? [],
          ...(row.turn_context.untrustedRoleplay
            ? {
                untrustedRoleplay: row.turn_context.untrustedRoleplay,
              }
            : {}),
        };
      }
    } catch {
      contextUnavailable = true;
    }
    requests.push({ npcId: row.npc_id, purpose: row.purpose, context });
  }
  const maps = new Set(turn.actorOrder.map((actorId) => state.entities[actorId]?.mapId));
  for (const [npcId, brain] of Object.entries(state.npcBrains ?? {})) {
    const npc = state.entities[npcId];
    if (
      !brain.living ||
      npc?.kind !== 'npc' ||
      npc.encounterId ||
      !isActorConscious(npc) ||
      !maps.has(npc.mapId) ||
      // Completed, running and free decisions are not billed a second time.
      rows.some((row) => row.npc_id === npcId && row.purpose === 'plan') ||
      // A frozen world roster excludes arrivals until the following round.
      (turn.phase === 'world' && turn.worldActorIds && !turn.worldActorIds.includes(npcId))
    )
      continue;
    try {
      requests.push({
        npcId,
        purpose: 'plan',
        context: { ...buildNpcDecisionContext(state, npcId), turnFence: turnFence(state) },
      });
    } catch {
      contextUnavailable = true;
    }
  }
  const optionalNpcIds = [
    ...new Set(
      requests.filter((request) => request.purpose === 'plan').map((request) => request.npcId),
    ),
  ];
  const optionalAutonomousSpeechRequests = ai.localAutonomousSpeechForecast
    ? optionalNpcIds.length
    : 0;
  let amount = 0;
  let unavailableReason: WorldRoundForecast['unavailableReason'] = contextUnavailable
    ? 'context_unavailable'
    : undefined;
  for (const request of requests) {
    const estimate = ai.localRequestForecast(request.purpose, request.context);
    if (estimate === null || !Number.isSafeInteger(estimate) || estimate < 0) {
      unavailableReason ??= 'pricing_unavailable';
      continue;
    }
    amount += estimate;
    if (!Number.isSafeInteger(amount)) unavailableReason = 'pricing_unavailable';
  }
  const baseAmount = amount;
  const baseUnavailable = unavailableReason;
  let optionalAmount = 0,
    optionalUnestimated = 0;
  if (ai.localAutonomousSpeechForecast) {
    for (const npcId of optionalNpcIds) {
      try {
        const contexts = prepareOptionalSpeech?.(state, npcId) ?? [];
        const estimates = contexts.map((context) => ai.localAutonomousSpeechForecast!(context));
        if (
          !estimates.length ||
          estimates.some((value) => value === null || !Number.isSafeInteger(value) || value < 0)
        ) {
          optionalUnestimated++;
          continue;
        }
        // Current say/whisper examples, not a universal bound on a future plan.
        const current = Math.max(...(estimates as number[]));
        if (!Number.isSafeInteger(optionalAmount + current)) {
          optionalUnestimated++;
          continue;
        }
        optionalAmount += current;
      } catch {
        optionalUnestimated++;
      }
    }
  }
  if (optionalUnestimated) unavailableReason ??= 'context_unavailable';
  amount += optionalAmount;
  if (!Number.isSafeInteger(amount)) unavailableReason = 'pricing_unavailable';
  const allowance = ai.localAutonomousSpeechAllowance?.();
  const allowanceAmount =
    allowance != null &&
    Number.isSafeInteger(allowance) &&
    allowance >= 0 &&
    Number.isSafeInteger(allowance * optionalAutonomousSpeechRequests)
      ? allowance * optionalAutonomousSpeechRequests
      : null;

  return {
    basis: 'local_round_forecast',
    estimatedTotalMicros: unavailableReason ? null : amount,
    estimatedSparkSubunits: unavailableReason
      ? null
      : providerMicrosToSparkSubunits(String(amount)),
    baseEstimatedSparkSubunits: baseUnavailable
      ? null
      : providerMicrosToSparkSubunits(String(baseAmount)),
    optionalAutonomousSpeechSparkSubunits: optionalUnestimated
      ? null
      : providerMicrosToSparkSubunits(String(optionalAmount)),
    optionalAutonomousSpeechAllowanceSubunits:
      allowanceAmount === null ? null : providerMicrosToSparkSubunits(String(allowanceAmount)),
    optionalAutonomousSpeechUnestimatedRequests: optionalUnestimated,
    requestCount:
      requests.length + (ai.localAutonomousSpeechForecast ? optionalAutonomousSpeechRequests : 0),
    optionalAutonomousSpeechRequests: ai.localAutonomousSpeechForecast
      ? optionalAutonomousSpeechRequests
      : 0,
    includesMapAnalysis: false,
    finalQuoteRequired: true,
    ...(unavailableReason ? { unavailableReason } : {}),
  };
}

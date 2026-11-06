import {
  storyItemPlacementContext,
  claimedStoryItemPlacements,
  inconsistentStoryPlacementNarration,
  storyItemPlacementOutcomeText,
} from './story-item-placement';
import { storyItemTransferContext, claimedStoryItemTransfers } from './story-item-transfers';
import {
  sceneEncounterCandidates,
  applySceneEncounter,
  sceneEncounterOutcomeText,
} from './story-scene-encounters';
import { sharesScene } from './scene-presence';
import { applyStoryOrderedAction } from './story-ordered-actions';
import { admitStoryRoleplayAttempt, storyAttemptEvidenceIds } from './story-roleplay';
import { explicitStoryPickup, materializeStoryItem, applyStoryPickup } from './story-items';
import {
  resolveTravelRequest,
  resolveTravelDestination,
  normalizeLocationName,
  travelToLocation,
} from './location-travel';
import { isNpcStoryContact, storyContactOutcomeCode } from './story-attacks';
import { applyStoryImpact, narrativeImpactOutcomeText, storyImpactContext } from './story-impact';
import { observedVisible } from './observation-visibility';
import {
  hasPosition,
  actorLifeState,
  isActorConscious,
  footprintDistance,
  occupiedCells,
  readNarrativePreferences,
  storyTurnInputSchema,
  storyTurnProposalSchema,
  storyActionSchema,
  gameActionSchema,
  type StoryTurnInput,
  type Locale,
  type StorySegment,
  type StoryActionPreview,
  type StoryTurnProposal,
  type StoryTravelIntent,
  type GameState,
  type GameAction,
  type GameResult,
  type StoryFeedEntry,
} from '@dreamwalk/contracts';
import { applyAction, visible, projectState, findPath, walkable } from './index';
import { recordNpcEvents } from './npc';
import { parsePlayerTextAction } from './living-reasoning';
import {
  applyNpcSpeech,
  admittedNpcSpeechObservationId,
  buildNpcPublicSpeechContext,
  selectNpcSpeechObservationIds,
  commitNpcPublicUtterance,
  canNpcHear,
  npcSpeechListenerIds,
  npcSpeechProspectiveListenerIds,
  npcSpeechHearingRange,
  npcRoleplayObserverIds,
  npcContextFingerprint,
  publicNpcFactTopics,
  resolveNpcFactTopic,
  createMockNpcPublicResponse,
} from './living';
import {
  narrativeSceneAudience,
  buildNarrativeContext,
  createMockNarrativeProposal,
  applyNarrativeProposal,
} from './narrative';
export function parseStorySegments(text: string): { segments: StorySegment[]; code?: string } {
  const segments: StorySegment[] = [];
  let buffer = '',
    attempt = false;
  const flush = () => {
    if (buffer.trim())
      segments.push({
        index: segments.length,
        kind: attempt ? 'attempt' : 'speech',
        text: buffer.trim(),
      });
    buffer = '';
  };
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && (text[i + 1] === '*' || text[i + 1] === '\\')) {
      buffer += text[++i];
      continue;
    }
    if (text[i] === '*') {
      if (attempt && !buffer.trim()) return { segments: [], code: 'INVALID_MARKUP' };
      flush();
      attempt = !attempt;
    } else buffer += text[i];
  }
  if (attempt) return { segments: [], code: 'INVALID_MARKUP' };
  flush();
  if (!segments.length) return { segments: [], code: 'INVALID_MARKUP' };
  if (segments.length > 6 || segments.filter((s) => s.kind === 'attempt').length > 2)
    return { segments: [], code: 'TOO_MANY_SEGMENTS' };
  return { segments };
}
export type StorySafeEntry = Omit<
  StoryFeedEntry,
  'id' | 'sequence' | 'createdAt' | 'turnId' | 'legacy'
> & {
  audienceIds: string[];
  sourceId?: string;
  sourceSegmentIndex?: number;
  speakerKnownToIds?: string[];
};
const normalize = (s: string) =>
  s
    .trim()
    .toLocaleLowerCase()
    .replace(/[?!.,]+$/u, '');
const listeners = (s: GameState, speakerId: string) =>
  Object.values(s.entities)
    .filter((e) => ['npc', 'player'].includes(e.kind) && canNpcHear(s, e, s.entities[speakerId]))
    .map((e) => e.id)
    .sort();
function allowedAction(state: GameState, actorId: string, input: unknown): GameAction | null {
  const p = gameActionSchema.safeParse(input);
  if (!p.success) return null;
  if (p.data.kind === 'travel') return state.maps[p.data.targetId ?? ''] ? p.data : null;
  const actor = state.entities[actorId];
  if (actor?.kind !== 'player') return null;
  if (p.data.targetId) {
    const target = state.entities[p.data.targetId];
    if (
      !target ||
      !(
        visible(state, actor, target) ||
        (['consume', 'pick_up', 'drop'].includes(p.data.kind) &&
          target.ownerId === actorId &&
          actor.inventory?.includes(target.id))
      )
    )
      return null;
  }
  if (p.data.itemId && !(actor.inventory ?? []).includes(p.data.itemId)) return null;
  return p.data;
}
function safeSpeech(
  state: GameState,
  actorId: string,
  npcId: string,
  channel: 'say' | 'whisper',
  segment: StorySegment,
  turnId: string,
  selectedObservationIds?: string[],
  replyLocale: Locale = 'en',
  sharedDirector = false,
  audienceLimit?: string[],
  preauthorizedObservationIds?: string[],
) {
  const identity = { turnId, segmentIndex: segment.index };
  const speech = { channel, text: segment.text };
  const applied = applyNpcSpeech(state, actorId, npcId, speech, {
    suppressReply: true,
    identity,
    audienceLimit,
  });
  if (applied.error) throw new Error(applied.error);
  const next = recordNpcEvents(
    state,
    applied.state,
    applied.events,
    `turn:${turnId}:${segment.index}`,
  ).state;
  const marker = admittedNpcSpeechObservationId(next, actorId, npcId, speech, identity);
  if (!marker) throw new Error('STALE_STATE');
  const audience = npcSpeechProspectiveListenerIds(next, npcId, channel).filter(
    (id) =>
      (!audienceLimit || audienceLimit.includes(id)) &&
      (hasPosition(next.entities[npcId]) ||
        channel !== 'whisper' ||
        id === actorId ||
        id === npcId),
  );
  const topics = publicNpcFactTopics(next, npcId).filter(
    (t) => normalize(t.title) === normalize(segment.text),
  );
  const requested =
    !sharedDirector && topics.length === 1 ? resolveNpcFactTopic(next, npcId, topics[0].id) : [];
  let ids =
    selectedObservationIds ??
    selectNpcSpeechObservationIds(
      next,
      npcId,
      sharedDirector
        ? [
            ...new Set([
              ...audience,
              ...Object.values(next.entities)
                .filter((entity) => entity.kind === 'player')
                .map((entity) => entity.id),
            ]),
          ]
        : audience,
      [marker],
      requested,
    );
  if (preauthorizedObservationIds) {
    const currentAttempts = storyAttemptEvidenceIds(next, actorId, npcId, turnId, segment.index);
    ids = ids.filter(
      (id) =>
        id === marker || preauthorizedObservationIds.includes(id) || currentAttempts.includes(id),
    );
  }
  if (sharedDirector) {
    // The director also writes globally visible narration. Local permission to hear
    // an old whisper or to release an asked secret must not become shared context.
    const readers = Object.values(next.entities)
      .filter((e) => e.kind === 'player')
      .map((e) => e.id);
    ids = ids.filter((id) => {
      if (id === marker) return true; // This new statement was explicitly sent to the shared director.
      const observation = next.npcBrains?.[npcId]?.living?.observations.find((o) => o.id === id);
      return (
        observation?.disclosure === 'public' ||
        (observation?.disclosure === 'participants' &&
          readers.every((reader) => observation.audienceIds.includes(reader)))
      );
    });
  }
  const admittedRequested = requested.filter((id) => ids.includes(id));
  const safe = buildNpcPublicSpeechContext(
    next,
    npcId,
    audience,
    ids,
    admittedRequested,
    undefined,
    replyLocale,
    actorId,
  );
  const current = safe.claims.find((c) => c.observationId === marker);
  if (!current) throw new Error('FORBIDDEN');
  return {
    state: next,
    sourceId: next.npcUtterances?.find(
      (u) => u.speakerId === actorId && !state.npcUtterances?.some((old) => old.id === u.id),
    )?.id,
    events: applied.events,
    context: {
      ...safe,
      segmentIndex: segment.index,
      replyToObservationId: marker,
      currentUtterance: current,
      observationIds: safe.claims.map((c) => c.observationId),
      requestedFactIds: admittedRequested,
      speechHash: npcContextFingerprint(safe),
    },
  };
}
/** Bind a generated voice to the public evidence it actually received. The engine's
 * full speech hash additionally binds current listeners/private mechanics at commit. */
function directorVoice(context: ReturnType<typeof safeSpeech>['context']) {
  const evidence = {
    npcId: context.npcId,
    lifeRevision: 'lifeRevision' in context ? (context.lifeRevision ?? 0) : 0,
    replyLocale: context.replyLocale,
    claims: context.claims,
    segmentIndex: context.segmentIndex,
    replyToObservationId: context.replyToObservationId,
    currentUtterance: context.currentUtterance,
    observationIds: context.observationIds,
    requestedFactIds: context.requestedFactIds,
    ...('publicIdentity' in context ? { publicIdentity: context.publicIdentity } : {}),
    ...('currentPlace' in context ? { currentPlace: context.currentPlace } : {}),
    ...('publicSpeechStyle' in context ? { publicSpeechStyle: context.publicSpeechStyle } : {}),
    ...('performance' in context ? { performance: context.performance } : {}),
  };
  return {
    ...evidence,
    audienceIds: context.audienceIds,
    speechHash: npcContextFingerprint(evidence),
  };
}
/** Disclosure is authorized against the original snapshot, not a simulated gift,
 * recovery, relationship change or another branch visible to the same model. */
function storyVoiceEvidenceIds(
  state: GameState,
  actorId: string,
  npcId: string,
  input: StoryTurnInput,
  segment: StorySegment,
) {
  const audience =
    storyPrivateAudience(actorId, input) ??
    Object.values(state.entities)
      .filter((entity) => entity.kind === 'player')
      .map((entity) => entity.id);
  const memory = state.npcBrains?.[npcId]?.living;
  const active = isActorConscious(state.entities[npcId]);
  const topics =
    active && input.channel === 'whisper'
      ? publicNpcFactTopics(state, npcId).filter(
          (topic) => normalize(topic.title) === normalize(segment.text),
        )
      : [];
  const requested = topics.length === 1 ? resolveNpcFactTopic(state, npcId, topics[0].id) : [];
  return (memory?.observations ?? [])
    .filter(
      (observation) =>
        observation.disclosure === 'public' ||
        (observation.disclosure === 'participants' &&
          audience.every((reader) => observation.audienceIds.includes(reader))) ||
        (active &&
          input.channel === 'whisper' &&
          observation.disclosure === 'private' &&
          ((observation.revealCondition === 'asked' && requested.includes(observation.id)) ||
            (observation.revealCondition === 'trusted' &&
              audience.every(
                (reader) => reader === npcId || (memory?.relationships[reader]?.trust ?? 0) >= 1,
              )))),
    )
    .map((observation) => observation.id);
}
type DirectorVoice = ReturnType<typeof directorVoice>;
type ImpactVoiceVariant = {
  afterImpact: { segmentIndex: number; targetId: string; effect: 'harm' | 'recover' | 'revive' };
  baseSpeechHash: string;
  changes: Partial<Omit<DirectorVoice, 'claims'>>;
  replacedClaims: DirectorVoice['claims'];
};
function restoreImpactVoice(base: DirectorVoice, variant: ImpactVoiceVariant): DirectorVoice {
  const fields = { ...base, ...variant.changes };
  return {
    ...fields,
    claims: fields.observationIds.flatMap((id) => {
      const claim =
        variant.replacedClaims.find((claim) => claim.observationId === id) ??
        base.claims.find((claim) => claim.observationId === id);
      return claim ? [claim] : [];
    }),
  };
}
/** At most two conditional voices for the explicitly addressed NPC. Authorization
 * comes from PRE-effect safe claims, never from hypothetical trust/revival. */
function prospectiveImpactVoices(
  state: GameState,
  actorId: string,
  input: StoryTurnInput,
  turnId: string,
  segments: StorySegment[],
  actionPreview: StoryActionPreview[],
  bases: DirectorVoice[],
) {
  const extraBases: DirectorVoice[] = [],
    variants: ImpactVoiceVariant[] = [];
  const npcId = input.targetNpcId;
  if (!npcId) return { bases: extraBases, variants };
  const target = storyImpactContext(state, actorId).find((entry) => entry.targetId === npcId);
  const effect =
    target?.lifeState === 'dead'
      ? 'revive'
      : target?.lifeState === 'unconscious'
        ? 'recover'
        : 'harm';
  if (
    !target?.allowedEffects.includes(effect) ||
    (effect === 'harm' && target.vitality <= target.maxDamage)
  )
    return { bases: extraBases, variants };
  const audience = storyPrivateAudience(actorId, input);
  const director = buildNarrativeContext(state, actorId, input.text, input.replyLocale, audience);
  const created = applyNarrativeProposal(
    state,
    actorId,
    {
      turnId,
      contextHash: director.contextHash,
      narration: 'Conditional current-scene outcome.',
      newScene: null,
      newNpc: null,
      evidenceIds: [],
      actions: [],
    },
    input.text,
    input.replyLocale,
    audience,
  );
  if (created.error) return { bases: extraBases, variants };
  const seed = recordNpcEvents(state, created.state, created.events, `story:${turnId}`).state;
  for (const attempt of segments.filter(
    (segment) =>
      segment.kind === 'attempt' &&
      !actionPreview.some((entry) => entry.segmentIndex === segment.index),
  )) {
    const speech = segments.find(
      (segment) => segment.index > attempt.index && segment.kind === 'speech',
    );
    if (!speech || variants.length >= 2) continue;
    let before = structuredClone(seed),
      after = structuredClone(seed);
    const effectIds: string[] = [];
    let valid = true;
    for (const segment of segments.filter((entry) => entry.index < speech.index)) {
      if (
        segment.kind === 'attempt' &&
        !actionPreview.some((entry) => entry.segmentIndex === segment.index)
      ) {
        for (const key of ['before', 'after'] as const) {
          const observed = admitStoryRoleplayAttempt(
            key === 'before' ? before : after,
            actorId,
            input,
            turnId,
            segment,
          );
          if (observed.error) {
            valid = false;
            break;
          }
          if (key === 'before') before = observed.state;
          else after = observed.state;
        }
        if (!valid) break;
      }
      if (segment.index === attempt.index) {
        const impacted = applyStoryImpact(
          after,
          actorId,
          turnId,
          segment.index,
          { targetId: npcId, effect },
          input,
        );
        if (impacted.error) {
          valid = false;
          break;
        }
        const oldIds = new Set(after.npcBrains?.[npcId]?.living?.observations.map((o) => o.id));
        after = recordNpcEvents(
          after,
          impacted.state,
          impacted.events,
          `impact:${turnId}:${segment.index}`,
        ).state;
        effectIds.push(
          ...(after.npcBrains?.[npcId]?.living?.observations ?? [])
            .filter(
              (o) =>
                !oldIds.has(o.id) &&
                ['harmed', 'revived', 'regained_consciousness', 'life_state_seen'].includes(o.kind),
            )
            .map((o) => o.id),
        );
      } else if (segment.kind === 'attempt') {
        const action = actionPreview.find((entry) => entry.segmentIndex === segment.index)?.action;
        if (!action) continue;
        for (const key of ['before', 'after'] as const) {
          const current = key === 'before' ? before : after;
          const permitted = allowedAction(current, actorId, action);
          if (!permitted) {
            valid = false;
            break;
          }
          const result =
            permitted.kind === 'pick_up'
              ? applyStoryPickup(current, actorId, permitted.targetId!, segment.text, input)
              : applyStoryOrderedAction(current, actorId, permitted, input);
          if (result.error) {
            valid = false;
            break;
          }
          const next = recordNpcEvents(
            current,
            result.state,
            result.events,
            `turn:${turnId}:${segment.index}`,
          ).state;
          if (key === 'before') before = next;
          else after = next;
        }
      } else {
        for (const key of ['before', 'after'] as const) {
          const current = key === 'before' ? before : after;
          const result = applyNpcSpeech(
            current,
            actorId,
            isActorConscious(current.entities[npcId]) ? npcId : undefined,
            { channel: input.channel, text: segment.text },
            {
              suppressReply: true,
              identity: { turnId, segmentIndex: segment.index },
              audienceLimit: audience,
            },
          );
          if (result.error) {
            valid = false;
            break;
          }
          const next = recordNpcEvents(
            current,
            result.state,
            result.events,
            `turn:${turnId}:${segment.index}`,
          ).state;
          if (key === 'before') before = next;
          else after = next;
        }
      }
      if (!valid) break;
    }
    if (!valid) continue;
    // A temporary active lens permits reading the dormant memory through unchanged
    // pre-effect disclosure/relationships. It is never a committed wake or a reply.
    before.entities[npcId].lifeState = 'conscious';
    before.entities[npcId].vitality = Math.max(1, before.entities[npcId].vitality ?? 1);
    try {
      const base = directorVoice(
        safeSpeech(
          before,
          actorId,
          npcId,
          input.channel,
          speech,
          turnId,
          undefined,
          input.replyLocale,
          input.channel === 'say',
          audience,
          storyVoiceEvidenceIds(state, actorId, npcId, input, speech),
        ).context,
      );
      const allowedIds = [...new Set([...base.observationIds, ...effectIds])];
      const prospective = directorVoice(
        safeSpeech(
          after,
          actorId,
          npcId,
          input.channel,
          speech,
          turnId,
          allowedIds,
          input.replyLocale,
          input.channel === 'say',
          audience,
        ).context,
      );
      const changes: ImpactVoiceVariant['changes'] = {};
      for (const key of Object.keys(prospective) as (keyof DirectorVoice)[]) {
        if (key !== 'claims' && JSON.stringify(base[key]) !== JSON.stringify(prospective[key]))
          Object.assign(changes, { [key]: prospective[key] });
      }
      const variant: ImpactVoiceVariant = {
        afterImpact: { segmentIndex: attempt.index, targetId: npcId, effect },
        baseSpeechHash: base.speechHash,
        changes,
        replacedClaims: prospective.claims.filter(
          (claim) =>
            JSON.stringify(base.claims.find((old) => old.observationId === claim.observationId)) !==
            JSON.stringify(claim),
        ),
      };
      const addBase = ![...bases, ...extraBases].some(
        (entry) => entry.speechHash === base.speechHash,
      );
      const nextBases = addBase ? [...extraBases, base] : extraBases;
      // Bounded additive context, independent of roster/target count. A missing voice
      // omits a reply, never the admitted physical consequence or privacy guard.
      if (
        new TextEncoder().encode(
          JSON.stringify({ bases: nextBases, variants: [...variants, variant] }),
        ).byteLength > 8192
      )
        continue;
      if (addBase) extraBases.push(base);
      variants.push(variant);
    } catch {
      /* No safe, audible prospective voice. */
    }
  }
  return { bases: extraBases, variants };
}

/** Routing follows the structured post, never a verb/weapon keyword list. */
export function storyTurnMode(input: StoryTurnInput): 'npc' | 'director' {
  return !input.targetNpcId ||
    parseStorySegments(input.text).segments.some((segment) => segment.kind === 'attempt')
    ? 'director'
    : 'npc';
}
export function storyPrivateAudience(actorId: string, input: StoryTurnInput): string[] | undefined {
  return input.channel === 'whisper'
    ? [...new Set([actorId, ...(input.targetNpcId ? [input.targetNpcId] : [])])].sort()
    : undefined;
}
/** Input attribution describes pre-admission intent, not a permanent ban on resolving it. */
export const storyDirectorRoleplayPolicy =
  'Player-authored RP is intent, not by itself a validated inventory, money, damage or movement change. This describes the input before adjudication, not the outcome of a supported typed effect selected for this turn. Resolve permitted effects through their listed capabilities; preserve harmless everyday roleplay naturally.';

// Bind policy upgrades into the semantic readset without duplicating the full prompt in context.
export const storyDirectorResolutionVersion = 'atomic-current-turn-ground-placement-v2';

/** Candidate prose is published with admission, never evidence of a future queued effect. */
export const storyDirectorResolutionPolicy =
  'Separate the current turn from historical evidence. actionOutcomes describes previews for current director segment indices; committedAttackOutcomes describes already persisted results at ORIGINAL post indices, not new actions to repeat. A current known failure or ACTION_PENDING for that same attempt/effect overrides candidate success. A failed attempt remains failed for that attempt, not for a later retry. When selecting a supported inline give or owned-item ground drop with no current known failure for its own attempt/effect, write its successful result as candidate narration, not as still unconfirmed: the engine validates the effect and publishes it together with narration only after all required admission and confirmation succeed. If that inline effect fails admission, neither its transfer nor its success narration is committed. Player intent alone and null-action emotes do not establish a tracked transfer or ground placement. travelIntent, queued paths and ACTION_PENDING remain unresolved; do not borrow the inline-effect rule for deferred effects. Historical confirmedTurns and evidenceIds describe their own past turns; a citation does not determine this turn outcome or current custody. Cite history only for relevant historical continuity; a current typed effect needs no old canon citation. Preserve ordinary RP and each NPC own audience-safe evidence; director resolution is not NPC knowledge.';

export function buildStoryTurnContext(
  state: GameState,
  actorId: string,
  raw: StoryTurnInput,
  turnId: string,
) {
  const input = storyTurnInputSchema.parse(raw),
    parsed = parseStorySegments(input.text);
  if (parsed.code) throw new Error(parsed.code);
  const actor = state.entities[actorId];
  if (actor?.kind !== 'player' || actor.encounterId) throw new Error('WRONG_MODE');
  if (
    hasPosition(actor) &&
    input.channel === 'whisper' &&
    !input.targetNpcId &&
    !parsed.segments.some((segment) => segment.kind === 'attempt')
  )
    throw new Error('PRIVATE_STORY_EXTENSION');
  if (input.expectedCanonRevision !== (state.narrativeCanon?.revision ?? 0))
    throw new Error('STALE_CANON');
  const mode = storyTurnMode(input),
    privateAudience = storyPrivateAudience(actorId, input);
  const travelRequests =
    mode === 'director' && parsed.segments.length === 1
      ? parsed.segments.flatMap((segment) => {
          const request =
            segment.kind === 'attempt' ? resolveTravelRequest(state, segment.text) : null;
          if (
            request &&
            !hasPosition(actor) &&
            !request.mapId &&
            Object.values(state.entities).some(
              (entity) =>
                observedVisible(state, actor, entity) &&
                [
                  entity.id,
                  entity.label ?? '',
                  ...Object.values(entity.labelTranslations ?? {}),
                ].some(
                  (name) =>
                    normalizeLocationName(name) === normalizeLocationName(request.destinationName),
                ),
            )
          )
            return [];
          return request ? [{ segmentIndex: segment.index, ...request }] : [];
        })
      : [];
  if (input.targetNpcId) {
    const npc = state.entities[input.targetNpcId];
    if (
      npc?.kind !== 'npc' ||
      (mode === 'npc' && !isActorConscious(npc)) ||
      !state.npcBrains?.[npc.id]?.living ||
      npc.encounterId ||
      !observedVisible(state, actor, npc) ||
      (mode === 'npc' &&
        !sharesScene(state, actor, npc) &&
        (!hasPosition(npc) || !hasPosition(actor) || footprintDistance(npc, actor) > 1))
    )
      throw new Error('OUT_OF_RANGE');
  }
  let simulated = structuredClone(state);
  const directorStates = new Map<number, GameState>();
  const attemptStates = new Map<number, GameState>();
  const actionOutcomes: { segmentIndex: number; code: string }[] = [];
  const actionPreview: StoryActionPreview[] = [],
    dialogues: ReturnType<typeof safeSpeech>['context'][] = [];
  for (const segment of parsed.segments) {
    if (mode === 'director' && segment.kind === 'speech')
      directorStates.set(segment.index, structuredClone(simulated));
    if (segment.kind === 'attempt') {
      if (mode === 'director') attemptStates.set(segment.index, structuredClone(simulated));
      const action = parsePlayerTextAction(simulated, actorId, segment.text);
      if (
        (mode === 'director' && (!action || isNpcStoryContact(simulated, action))) ||
        !hasPosition(actor)
      ) {
        const observed = admitStoryRoleplayAttempt(simulated, actorId, input, turnId, segment);
        if (observed.error) throw new Error(observed.error);
        simulated = observed.state;
        continue;
      }
      if (action) {
        const valid = allowedAction(simulated, actorId, action);
        if (!valid) throw new Error('UNSUPPORTED');
        const r =
          valid.kind === 'pick_up'
            ? applyStoryPickup(simulated, actorId, valid.targetId!, segment.text, input)
            : applyStoryOrderedAction(simulated, actorId, valid, input);
        if (
          (r.error === 'OUT_OF_RANGE' || r.error === 'PATH_BLOCKED') &&
          !(mode === 'director' && state.turnController?.phase === 'world')
        )
          throw new Error('WALK_FIRST');
        actionOutcomes.push({ segmentIndex: segment.index, code: storyContactOutcomeCode(r) });
        actionPreview.push({
          segmentIndex: segment.index,
          action: storyActionSchema.parse(valid),
        });
        if (!r.error)
          simulated = recordNpcEvents(
            simulated,
            r.state,
            r.events,
            `turn:${turnId}:${segment.index}`,
          ).state;
      }
    } else if (mode === 'npc' && input.targetNpcId) {
      const r = safeSpeech(
        simulated,
        actorId,
        input.targetNpcId,
        input.channel,
        segment,
        turnId,
        undefined,
        input.replyLocale,
      );
      simulated = r.state;
      dialogues.push(r.context);
    }
  }
  // Preview each eligible existing character with the same speech admission used at commit.
  // The director may see shared canon; these isolated voice contexts are the only evidence
  // an existing character response may use. Newborns have no inherited conversation.
  const sceneSpeakers =
    mode === 'director'
      ? parsed.segments
          .filter((segment) => segment.kind === 'speech')
          .flatMap((segment) => {
            const checkpoint = directorStates.get(segment.index)!;
            const speaker = checkpoint.entities[actorId];
            return Object.values(checkpoint.entities)
              .filter(
                (npc) =>
                  npc.kind === 'npc' &&
                  (input.channel !== 'whisper' || npc.id === input.targetNpcId) &&
                  (!input.targetNpcId || npc.id === input.targetNpcId) &&
                  isActorConscious(npc) &&
                  checkpoint.npcBrains?.[npc.id]?.living &&
                  visible(checkpoint, speaker, npc) &&
                  !npc.encounterId,
              )
              .sort(
                (a, b) =>
                  (hasPosition(speaker) && hasPosition(a) && hasPosition(b)
                    ? footprintDistance(speaker, a) - footprintDistance(speaker, b)
                    : 0) || a.id.localeCompare(b.id),
              )
              .slice(0, 4)
              .flatMap((npc) => {
                try {
                  return [
                    directorVoice(
                      safeSpeech(
                        checkpoint,
                        actorId,
                        npc.id,
                        input.channel,
                        segment,
                        turnId,
                        undefined,
                        input.replyLocale,
                        input.channel === 'say',
                        privateAudience,
                        // Moving into a scene changes perception, not permission to reveal memory.
                        storyVoiceEvidenceIds(state, actorId, npc.id, input, segment),
                      ).context,
                    ),
                  ];
                } catch {
                  return [];
                }
              });
          })
      : [];
  const impactVoices =
    mode === 'director'
      ? prospectiveImpactVoices(
          state,
          actorId,
          input,
          turnId,
          parsed.segments,
          actionPreview,
          sceneSpeakers,
        )
      : { bases: [], variants: [] };
  const view = projectState(state, actorId);
  const mechanics = view.entities
    .filter(
      (e) =>
        !input.targetNpcId ||
        visible(state, state.entities[input.targetNpcId], state.entities[e.id]),
    )
    .map((e) => ({
      id: e.id,
      kind: e.kind,
      label: e.label,
      open: e.open,
      locked: e.locked,
      ...(e.kind === 'npc' || e.kind === 'player' ? {} : { x: e.x, y: e.y }),
    }));
  const placementCandidates =
    mode === 'director'
      ? parsed.segments
          .filter((segment) => segment.kind === 'attempt')
          .map((segment) => ({
            segmentIndex: segment.index,
            ...storyItemPlacementContext(
              attemptStates.get(segment.index)!,
              actorId,
              segment.text,
              input,
            ),
          }))
          .filter((entry) => entry.items.length)
      : [];
  const safe = {
    schemaVersion: 1,
    turnId,
    actorId,
    mode,
    channel: input.channel,
    ...((privateAudience ?? narrativeSceneAudience(state, actorId))
      ? { outputAudienceIds: privateAudience ?? narrativeSceneAudience(state, actorId) }
      : {}),
    replyLocale: input.replyLocale ?? 'en',
    ...(state.narrativePreferences?.[actorId]
      ? { narrativePreferences: readNarrativePreferences(state, actorId) }
      : {}),
    targetNpcId: input.targetNpcId ?? null,
    segments: parsed.segments,
    mapId: actor.mapId,
    canonRevision: state.narrativeCanon?.revision ?? 0,
    mechanics,
    ...(mode === 'director'
      ? {
          roleplayPolicy: storyDirectorRoleplayPolicy,
          resolutionPolicy: storyDirectorResolutionVersion,
        }
      : {}),
    referencedInventory: (mode === 'director' ? view.inventory : [])
      .filter((item) =>
        parsed.segments.some(
          (segment) =>
            segment.kind === 'attempt' &&
            explicitStoryPickup(segment.text, [
              item.id,
              item.label ?? '',
              ...Object.values(item.labelTranslations ?? {}),
            ]),
        ),
      )
      .map((item) => ({ id: item.id, label: item.label, alreadyCarried: true as const })),
    ...(mode === 'director'
      ? {
          ...(placementCandidates.length
            ? {
                itemPlacementPolicy: {
                  segmentCandidates: placementCandidates,
                  instructions:
                    'Private named owned-item ground choices for the exact current attempt only. Ground only, no new item, surface or trajectory. Not NPC knowledge. Revalidate ordered effects; never authorize speech, negation, hypothetical, quotation or another actor intent.',
                },
              }
            : {}),
          itemTransferPolicy: {
            segmentCandidates: parsed.segments
              .filter((segment) => segment.kind === 'attempt')
              .map((segment) => ({
                segmentIndex: segment.index,
                ...storyItemTransferContext(
                  attemptStates.get(segment.index)!,
                  actorId,
                  segment.text,
                ),
              })),
            instructions:
              'Interpret an explicit current handoff semantically, not as a command keyword. Use action give with the matching owned item ID and visible recipient ID from this exact segment. Item mention alone, looking, gesturing, negation, a hypothetical, quoted speech or another actor action is not a handoff. These are private director references, never NPC knowledge or permission to enumerate inventory. Preserve ordinary untracked RP. A completed transfer requires its matching typed give. When selecting a supported give with no current known failure for its own attempt/effect, narrate its successful result conditionally on atomic admission, not as still unconfirmed. The server publishes the transfer and narration together only after all required checks and confirmation; failed admission publishes neither. Without that give, narrate only the attempt, refusal or obstacle. No invented items, owners or recipients.',
          },
        }
      : {}),
    actionPreview,
    actionOutcomes,
    travelRequests,
    ...(mode === 'director' && parsed.segments.some((segment) => segment.kind === 'attempt')
      ? {
          sceneEncounterPolicy: {
            maxEncounters: 1,
            candidates: sceneEncounterCandidates(state, actorId),
            segmentCandidates: parsed.segments
              .filter((segment) => segment.kind === 'attempt')
              .map((segment) => ({
                segmentIndex: segment.index,
                candidates: sceneEncounterCandidates(attemptStates.get(segment.index)!, actorId),
              })),
            instructions:
              'Use sceneEncounter only for an actual current encounter-seeking player attempt supported by the source fiction. These compiler-qualified unresolved opening NPCs are not already visible, present, or recognized. Respect negation, hypotheticals, quoted speech, explicit source absence and concealment. Do not infer an encounter from ordinary speech or a name mention. One candidate per turn. Do not provide an action, impact, reply or quote for that character in this turn. The server admits a typed encounter summary, then normal dialogue can occur in a later turn. Never expose candidate lists or private author biography.',
          },
        }
      : {}),
    ...(mode === 'director'
      ? {
          narrativeImpactPolicy: {
            maxImpacts: 1,
            allowedEffects: ['harm', 'blocked', 'unconscious', 'death', 'recover', 'revive'],
            explicitLifecycle: true,
            targets: storyImpactContext(state, actorId),
            segmentTargets: parsed.segments
              .filter((segment) => segment.kind === 'attempt')
              .map((segment) => ({
                segmentIndex: segment.index,
                targets: storyImpactContext(attemptStates.get(segment.index)!, actorId),
              })),
            instructions:
              'Adjudicate the current explicit attempt from its meaning and established fiction, not a keyword list or inventory gate. One visible existing NPC can receive harm, unconsciousness, death, recovery or revival according to its listed allowedEffects. Use segmentTargets for this exact attempt index: earlier ordered movement can change the reachable scene. Initial targets are context, not authority to affect someone left behind. Harm at zero vitality causes unconsciousness; death must be explicit. Recovery never revives a dead actor. Revival requires a distinct current attempt justified by the established fiction, never a retry, food, or old dialogue. Do not force travel, grant inventory or invent exceptional powers. Player targets keep their existing reaction mechanics. Use no action or reply on the same impact segment. Independent segments resolve in order; an inactive NPC cannot reply later.',
          },
        }
      : {}),
    dialogues,
    ...(mode === 'director'
      ? {
          sceneSpeakers,
          sceneSpeakerImpactBases: impactVoices.bases,
          sceneSpeakerImpactVariants: impactVoices.variants,
        }
      : {}),
    ...(mode === 'director'
      ? {
          director: buildNarrativeContext(
            state,
            actorId,
            input.text,
            input.replyLocale,
            privateAudience,
          ),
        }
      : {}),
    allowedActions: !hasPosition(actor)
      ? travelRequests.length
        ? ['travel']
        : []
      : [
          'inspect',
          'open',
          'close',
          'unlock',
          'pick_up',
          'consume',
          'give',
          'wait',
          ...(mode === 'director' ? ['move_to', 'transition', 'drop'] : []),
          ...(mode === 'director' && !state.turnController ? ['approach'] : []),
          ...(travelRequests.length ? ['travel'] : []),
        ],
    itemPolicy: !hasPosition(actor)
      ? 'No coordinate-based pickup or physical action is established. Preserve an attributed attempt unless the semantic consequence is explicitly admitted.'
      : mode === 'director'
        ? 'An explicit pickup/pocket attempt can use pick_up with an existing visible item ID. For a newly encountered ordinary prop, provide narrative.newItem and targetId=new_item in its matching attempt. No powers, payment, secrets, alleged prior owner or duplicate item. Use referencedInventory only for the actor own current pickup/pocket request; never enumerate private inventory to NPCs or shared narration. Already carried items stay carried.'
        : undefined,
    sceneInteractionPolicy:
      mode === 'director'
        ? 'Materialize new people through newNpc. Use new_npc only for the new character in this proposal. approach requires an explicit player attempt; speech replies require replyNpcId and use only that character perceived evidence plus attributed player speech, never narrator omniscience.'
        : undefined,
  };
  const readset = {
    actor: {
      mapId: actor.mapId,
      ...(hasPosition(actor)
        ? { x: actor.x, y: actor.y }
        : { spatialMode: actor.spatialMode, sceneId: actor.sceneId }),
      inventory: actor.inventory ?? [],
    },
    source: state.narrativeSource ?? null,
    ...safe,
  };
  return {
    ...safe,
    confirmationHash: npcContextFingerprint(actionPreview),
    contextHash: npcContextFingerprint(readset),
  };
}
export type StoryTurnContext = ReturnType<typeof buildStoryTurnContext>;
export function createMockStoryTurnProposal(
  state: GameState,
  actorId: string,
  input: StoryTurnInput,
  turnId: string,
): StoryTurnProposal {
  const context = buildStoryTurnContext(state, actorId, input, turnId);
  const selectedVoice = context.mode === 'director' ? context.sceneSpeakers?.at(-1) : undefined;
  const steps: StoryTurnProposal['steps'] = context.segments.map((segment) => ({
    segmentIndex: segment.index,
    action:
      segment.kind === 'attempt' &&
      context.travelRequests.some(
        (request) => request.segmentIndex === segment.index && !request.ambiguous,
      )
        ? {
            kind: 'travel' as const,
            targetId:
              context.travelRequests.find((request) => request.segmentIndex === segment.index)!
                .mapId ?? 'new_scene',
          }
        : segment.kind === 'attempt'
          ? (context.actionPreview.find((a) => a.segmentIndex === segment.index)?.action ?? null)
          : null,
    reply:
      segment.kind === 'speech' && context.mode === 'npc'
        ? createMockNpcPublicResponse(
            context.dialogues.find((d) => d.segmentIndex === segment.index)!,
          )
        : selectedVoice?.segmentIndex === segment.index
          ? createMockNpcPublicResponse(selectedVoice)
          : null,
    ...(selectedVoice?.segmentIndex === segment.index
      ? { replyNpcId: selectedVoice.npcId, replyContextHash: selectedVoice.speechHash }
      : {}),
  }));
  if (
    hasPosition(state.entities[actorId]) &&
    (context.mode === 'npc' || !state.turnController) &&
    steps.some((step, i) => context.segments[i].kind === 'attempt' && !step.action)
  )
    return {
      turnId,
      contextHash: context.contextHash,
      status: 'clarification',
      code: 'AMBIGUOUS',
      steps: [],
      narrative: null,
    };
  const narrative =
    context.mode === 'director'
      ? createMockNarrativeProposal(
          state,
          actorId,
          input.text,
          turnId,
          input.replyLocale,
          storyPrivateAudience(actorId, input),
        )
      : null;
  const travel = context.travelRequests[0];
  if (travel && narrative) {
    narrative.newNpc = null;
    if (travel.mapId) narrative.newScene = null;
    else if (narrative.newScene) narrative.newScene.name = travel.destinationName;
    narrative.narration = {
      en: `The journey continues in ${travel.destinationName}.`,
      ru: `История продолжается в локации «${travel.destinationName}».`,
      uk: `Історія продовжується в локації «${travel.destinationName}».`,
    }[input.replyLocale ?? 'en'];
  }
  return {
    turnId,
    contextHash: context.contextHash,
    status: 'ready',
    code: null,
    steps,
    narrative: narrative
      ? {
          narration: narrative.narration,
          newScene: narrative.newScene,
          newNpc: narrative.newNpc,
          evidenceIds: narrative.evidenceIds,
        }
      : null,
  };
}
export interface StoryTurnApplied extends GameResult {
  entries: StorySafeEntry[];
  actions: StoryActionPreview[];
  clarification?: string;
  pendingTravel?: StoryTravelIntent;
}
export function applyStoryTurnProposal(
  state: GameState,
  actorId: string,
  input: StoryTurnInput,
  turnId: string,
  raw: unknown,
  options: {
    speechAlreadyRecorded?: boolean;
    sourceSpeechSegments?: { index: number; text: string }[];
    /** Server-validated image placement before any arrival observation is recorded. */
    prepareTravelPlacement?: (state: GameState) => GameState;
  } = {},
): StoryTurnApplied {
  const reject = (code: GameResult['error'] = 'STALE_STATE'): StoryTurnApplied => ({
    state,
    events: [],
    entries: [],
    actions: [],
    error: code,
  });
  const parsed = storyTurnProposalSchema.safeParse(raw);
  if (!parsed.success) return reject('INVALID_ACTION');
  let context: StoryTurnContext;
  try {
    context = buildStoryTurnContext(state, actorId, input, turnId);
  } catch {
    return reject();
  }
  const privateAudience = storyPrivateAudience(actorId, input);
  const p = parsed.data;
  if (p.turnId !== turnId || p.contextHash !== context.contextHash) return reject();
  if (p.status === 'clarification') {
    if (!p.code || p.steps.length || p.narrative || p.travelIntent) return reject('INVALID_ACTION');
    return { state, events: [], entries: [], actions: [], clarification: p.code };
  }
  if (
    p.code ||
    p.steps.length !== context.segments.length ||
    p.steps.some((s, i) => s.segmentIndex !== context.segments[i].index)
  )
    return reject('INVALID_ACTION');
  if (context.mode === 'npc' && p.narrative) return reject('FORBIDDEN');
  if (
    context.mode === 'director' &&
    (!p.narrative || p.steps.filter((step) => step.reply).length > 1)
  )
    return reject('INVALID_ACTION');
  if (
    p.travelIntent &&
    (context.mode !== 'director' ||
      input.channel !== 'say' ||
      !state.turnController ||
      !context.segments.some(
        (segment) => segment.kind === 'attempt' && segment.index === p.travelIntent!.segmentIndex,
      ) ||
      p.narrative?.newScene ||
      p.steps.some((step) => step.action?.kind === 'travel'))
  )
    return reject('FORBIDDEN');
  const actions: StoryActionPreview[] = [];
  if (
    p.steps.filter((step) => step.narrativeImpact).length > 1 ||
    (p.steps.some((step) => step.narrativeImpact) &&
      (context.mode !== 'director' || !['say', 'whisper'].includes(input.channel)))
  )
    return reject('FORBIDDEN');
  const encounters = p.steps.filter((step) => step.sceneEncounter);
  if (
    encounters.length > 1 ||
    (encounters.length &&
      (context.mode !== 'director' ||
        p.steps.some((step) => step.replyNpcId === encounters[0].sceneEncounter!.npcId)))
  )
    return reject('FORBIDDEN');
  for (const [i, segment] of context.segments.entries()) {
    const step = p.steps[i];
    if (
      step.sceneEncounter &&
      (segment.kind !== 'attempt' ||
        step.action ||
        step.narrativeImpact ||
        step.reply ||
        !context.sceneEncounterPolicy?.segmentCandidates
          .find((entry) => entry.segmentIndex === segment.index)
          ?.candidates.some((candidate) => candidate.npcId === step.sceneEncounter!.npcId))
    )
      return reject('FORBIDDEN');
    if (step.narrativeImpact) {
      if (
        segment.kind !== 'attempt' ||
        step.action ||
        step.reply ||
        context.actionPreview.some((entry) => entry.segmentIndex === segment.index) ||
        !context.narrativeImpactPolicy?.segmentTargets
          .find((entry) => entry.segmentIndex === segment.index)
          ?.targets.some(
            (target) =>
              target.targetId === step.narrativeImpact!.targetId &&
              target.allowedEffects.includes(step.narrativeImpact!.effect),
          )
      )
        return reject('FORBIDDEN');
    }
    if (context.mode === 'director' && step.reply && 'text' in step.reply) {
      // Director voices carry public speech evidence, not private action targets.
      // A newborn has no provider-visible current observation before admission.
      if (
        (step.replyNpcId === 'new_npc' &&
          (step.reply.companionIntent || step.reply.actionIntent)) ||
        step.reply.actionIntent?.actions.some((action) => action.kind !== 'wait')
      )
        return reject('FORBIDDEN');
    }
    if (segment.kind === 'attempt') {
      if (
        (context.mode === 'npc' && !step.action) ||
        step.reply ||
        step.replyNpcId ||
        step.replyContextHash
      )
        return reject('INVALID_ACTION');
      if (step.action)
        actions.push({
          segmentIndex: segment.index,
          action: step.action,
          ...(step.action.targetId === 'new_item' && p.narrative?.newItem
            ? { targetLabel: p.narrative.newItem.name }
            : {}),
          ...(step.action.targetId === 'new_npc' && p.narrative?.newNpc
            ? { targetLabel: p.narrative.newNpc.name }
            : {}),
        });
    } else if (
      step.action ||
      (context.mode === 'npc'
        ? !step.reply || Boolean(step.replyNpcId)
        : Boolean(step.reply) !== Boolean(step.replyNpcId))
    )
      return reject('INVALID_ACTION');
    if (
      context.mode === 'director' &&
      state.turnController &&
      step.action &&
      !['pick_up', 'travel', 'give', 'drop'].includes(step.action.kind) &&
      !context.actionPreview.some(
        (entry) =>
          entry.segmentIndex === segment.index &&
          JSON.stringify(entry.action) === JSON.stringify(step.action),
      )
    )
      return reject('FORBIDDEN');
    if (
      step.action &&
      ['move_to', 'transition'].includes(step.action.kind) &&
      !context.actionPreview.some(
        (entry) =>
          entry.segmentIndex === segment.index &&
          JSON.stringify(entry.action) === JSON.stringify(step.action),
      )
    )
      return reject('FORBIDDEN');
    if (step.action?.kind === 'drop') {
      const candidates = context.itemPlacementPolicy?.segmentCandidates.find(
        (entry) => entry.segmentIndex === segment.index,
      );
      if (
        context.mode !== 'director' ||
        step.action.itemId ||
        !step.action.target ||
        !candidates?.items.some(
          (item) =>
            item.id === step.action!.targetId &&
            item.points.some(
              (point) => point.x === step.action!.target!.x && point.y === step.action!.target!.y,
            ),
        )
      )
        return reject('FORBIDDEN');
    }
    if (step.action?.kind === 'give' && context.mode === 'director') {
      const candidates = context.itemTransferPolicy?.segmentCandidates.find(
        (entry) => entry.segmentIndex === segment.index,
      );
      if (
        step.action.target ||
        !candidates?.items.some((item) => item.id === step.action!.itemId) ||
        !candidates.recipients.some(
          (recipient) =>
            recipient.id === step.action!.targetId && recipient.reachable && recipient.hasCapacity,
        )
      )
        return reject('FORBIDDEN');
    }
    if (step.action?.kind === 'pick_up') {
      const target =
        step.action.targetId === 'new_item'
          ? p.narrative?.newItem
          : state.entities[step.action.targetId ?? ''];
      const labels =
        target &&
        ('name' in target
          ? [target.name]
          : [target.id, target.label ?? '', ...Object.values(target.labelTranslations ?? {})]);
      if (step.action.itemId || !labels || !explicitStoryPickup(segment.text, labels))
        return reject('FORBIDDEN');
    }
    if (step.action?.kind === 'travel') {
      const request = context.travelRequests.find((value) => value.segmentIndex === segment.index);
      const existingPreview =
        !request &&
        !p.narrative?.newScene &&
        !!state.maps[step.action.targetId ?? ''] &&
        context.actionPreview.some(
          (entry) =>
            entry.segmentIndex === segment.index &&
            JSON.stringify(entry.action) === JSON.stringify(step.action),
        );
      // Mixed posts preserve parsed existing-location actions in their original order.
      // An absent request never authorizes a new scene or a model-selected destination.
      if (
        !existingPreview &&
        (!request ||
          request.ambiguous ||
          step.action.itemId ||
          step.action.targetId !== (request.mapId ?? 'new_scene') ||
          (!request.mapId &&
            (!p.narrative?.newScene ||
              normalizeLocationName(p.narrative.newScene.name) !==
                normalizeLocationName(request.destinationName))) ||
          (request.mapId && p.narrative?.newScene))
      )
        return reject('FORBIDDEN');
    }
    if (
      step.action?.kind === 'approach' &&
      (context.mode !== 'director' || !step.action.targetId || step.action.itemId)
    )
      return reject('FORBIDDEN');
  }
  const droppedIds = p.steps
    .filter((step) => step.action?.kind === 'drop')
    .map((step) => step.action!.targetId!);
  if (
    p.narrative?.newItem &&
    (context.mode !== 'director' ||
      input.channel !== 'say' ||
      p.steps.filter(
        (step) => step.action?.kind === 'pick_up' && step.action.targetId === 'new_item',
      ).length !== 1)
  )
    return reject('FORBIDDEN');
  // A promised requested departure must have a committed travel effect, not narration alone.
  if (
    context.travelRequests.some(
      (request) =>
        !request.ambiguous &&
        !p.travelIntent &&
        p.steps.find((step) => step.segmentIndex === request.segmentIndex)?.action?.kind !==
          'travel',
    )
  )
    return reject('INVALID_ACTION');
  if (context.travelRequests.length > 1) return reject('INVALID_ACTION');
  const knownFailure = (segmentIndex: number, action: GameAction, code: string) => {
    const quoted = context.actionPreview.find((a) => a.segmentIndex === segmentIndex)?.action;
    return (
      !!quoted &&
      quoted.kind === action.kind &&
      quoted.targetId === action.targetId &&
      quoted.itemId === action.itemId &&
      context.actionOutcomes.some((o) => o.segmentIndex === segmentIndex && o.code === code)
    );
  };
  const unsupported = (): StoryTurnApplied => ({
    state,
    events: [],
    entries: [],
    actions: [],
    clarification: 'UNSUPPORTED',
  });
  const referencedPlacementItems = [
    ...new Map(
      (context.itemPlacementPolicy?.segmentCandidates ?? []).flatMap((entry) =>
        entry.items.map((item) => [item.id, item] as const),
      ),
    ).values(),
  ];
  const claimedPlacements = claimedStoryItemPlacements(
    p.narrative?.narration ?? '',
    referencedPlacementItems,
  );
  if (claimedPlacements.some((id) => !droppedIds.includes(id))) return unsupported();
  const placedItems = new Set<string>();
  const referencedTransferItems = [
    ...new Map(
      (context.itemTransferPolicy?.segmentCandidates ?? []).flatMap((entry) =>
        entry.items.map((item) => [item.id, item] as const),
      ),
    ).values(),
  ];
  const claimedTransfers = claimedStoryItemTransfers(
    p.narrative?.narration ?? '',
    referencedTransferItems,
    [
      ...new Map(
        (context.itemTransferPolicy?.segmentCandidates ?? []).flatMap((entry) =>
          entry.recipients.map((recipient) => [recipient.id, recipient] as const),
        ),
      ).values(),
    ],
  );
  if (
    claimedTransfers.some(
      (claim) =>
        !p.steps.some(
          (step) =>
            step.action?.kind === 'give' &&
            step.action.itemId === claim.itemId &&
            step.action.targetId === claim.recipientId,
        ),
    )
  )
    return unsupported();
  const transferredItems = new Set<string>();
  const entries: StorySafeEntry[] = [];
  let next = structuredClone(state);
  const events: GameResult['events'] = [];
  const push = (entry: Omit<StorySafeEntry, 'ordinal' | 'tick'>) => {
    // Capture recognition at emission, never from the reader's later visibility.
    const speaker = entry.authorId && next.entities[entry.authorId];
    const source = entry.sourceId && next.npcUtterances?.find((u) => u.id === entry.sourceId);
    const identity = ['speech', 'npc_reply'].includes(entry.kind)
      ? {
          speakerKnownToIds: source
            ? [...(source.speakerKnownToIds ?? [])]
            : speaker
              ? entry.audienceIds.filter(
                  (id) =>
                    id === speaker.id ||
                    (!!next.entities[id] && observedVisible(next, next.entities[id], speaker)),
                )
              : [],
        }
      : {};
    entries.push({ ...entry, ...identity, ordinal: entries.length, tick: state.tick });
  };
  if (context.mode === 'director') {
    // Materialize the typed scene before resolving its ordered interactions. All mutations
    // remain in this local proposal until every action and speech admission succeeds.
    const directorContext = buildNarrativeContext(
      next,
      actorId,
      input.text,
      input.replyLocale,
      privateAudience,
    );
    const created = applyNarrativeProposal(
      next,
      actorId,
      {
        turnId,
        contextHash: directorContext.contextHash,
        narration: p.narrative!.narration,
        newScene: p.narrative!.newScene,
        newNpc: p.narrative!.newNpc,
        evidenceIds: p.narrative!.evidenceIds,
        actions: [],
      },
      input.text,
      input.replyLocale,
      privateAudience,
    );
    if (created.error) return reject(created.error);
    next = recordNpcEvents(next, created.state, created.events, `story:${turnId}`).state;
    events.push(...created.events);
    if (p.narrative?.newItem) {
      const materialized = materializeStoryItem(next, actorId, turnId, p.narrative.newItem);
      if (materialized.error) return reject(materialized.error);
      next = recordNpcEvents(
        next,
        materialized.state,
        materialized.events,
        `story-item:${turnId}`,
      ).state;
      events.push(...materialized.events);
      next.narrativeCanon!.turns.find((turn) => turn.id === turnId)!.introducedItem = {
        id: `prop-${turnId}`,
        ...p.narrative.newItem,
      };
    }
    const resolveNpc = (id: string) =>
      id === 'new_npc' && p.narrative?.newNpc ? `support-${turnId}` : id;
    let speechOrdinal = 0;
    let advisoryReplyOmitted = false;
    for (const [i, segment] of context.segments.entries()) {
      const originalSpeech =
        segment.kind === 'speech' ? options.sourceSpeechSegments?.[speechOrdinal++] : undefined;
      if (originalSpeech && originalSpeech.text !== segment.text) return reject('STALE_STATE');
      const audience =
        privateAudience &&
        (!hasPosition(next.entities[actorId]) || !(segment.kind === 'speech' && !input.targetNpcId))
          ? privateAudience
          : segment.kind === 'speech'
            ? npcSpeechListenerIds(next, actorId, { channel: input.channel, text: segment.text })
            : npcRoleplayObserverIds(next, actorId, input);
      push({
        kind: segment.kind,
        sourceSegmentIndex: originalSpeech?.index ?? segment.index,
        channel: input.channel,
        authorId: actorId,
        authorLabel: next.entities[actorId].label,
        text: segment.text,
        audienceIds: audience,
      });
      const admitCurrentSpeech = () => {
        if (options.speechAlreadyRecorded) return undefined;
        const addressed =
          input.targetNpcId &&
          isActorConscious(next.entities[input.targetNpcId]) &&
          canNpcHear(
            next,
            next.entities[input.targetNpcId],
            next.entities[actorId],
            npcSpeechHearingRange({ channel: input.channel, text: segment.text }),
          )
            ? input.targetNpcId
            : undefined;
        const spoken = applyNpcSpeech(
          next,
          actorId,
          addressed,
          { channel: input.channel, text: segment.text },
          {
            suppressReply: true,
            identity: { turnId, segmentIndex: originalSpeech?.index ?? segment.index },
            audienceLimit: input.targetNpcId ? privateAudience : undefined,
          },
        );
        if (spoken.error) return spoken.error;
        const source = spoken.state.npcUtterances?.find(
          (entry) =>
            entry.speakerId === actorId && !next.npcUtterances?.some((old) => old.id === entry.id),
        );
        entries[entries.length - 1].sourceId = source?.id;
        if (source) {
          entries[entries.length - 1].audienceIds = source.audienceIds;
          entries[entries.length - 1].speakerKnownToIds = source.speakerKnownToIds;
        }
        next = recordNpcEvents(
          next,
          spoken.state,
          spoken.events,
          `turn:${turnId}:${segment.index}`,
        ).state;
        events.push(...spoken.events);
        return undefined;
      };
      if (segment.kind === 'attempt') {
        if (!context.actionPreview.some((entry) => entry.segmentIndex === segment.index)) {
          const observed = admitStoryRoleplayAttempt(next, actorId, input, turnId, segment);
          if (observed.error) return reject(observed.error);
          next = observed.state;
          events.push(...observed.events);
          entries[entries.length - 1].sourceId = observed.source?.id;
          entries[entries.length - 1].audienceIds = observed.source?.audienceIds ?? [];
          entries[entries.length - 1].speakerKnownToIds = observed.source?.speakerKnownToIds ?? [];
        }
        const encounter = p.steps[i].sceneEncounter;
        if (encounter) {
          const candidate = context
            .sceneEncounterPolicy!.segmentCandidates.find(
              (entry) => entry.segmentIndex === segment.index,
            )!
            .candidates.find((entry) => entry.npcId === encounter.npcId)!;
          const outcome = applySceneEncounter(
            next,
            actorId,
            turnId,
            segment.index,
            encounter.npcId,
            candidate.fingerprint,
            input,
          );
          if (outcome.error) return reject(outcome.error);
          next = recordNpcEvents(
            next,
            outcome.state,
            outcome.events,
            `scene-encounter:${turnId}:${segment.index}`,
          ).state;
          events.push(...outcome.events);
          push({
            kind: 'outcome',
            channel: input.channel,
            authorId: actorId,
            code: 'SCENE_ENCOUNTERED',
            text: sceneEncounterOutcomeText(
              next.entities[
                next.narrativeCanon!.turns.find((entry) => entry.id === turnId)!.sceneEncounter!
                  .npcId
              ].label ?? 'someone',
              input.replyLocale,
            ),
            audienceIds: privateAudience ?? narrativeSceneAudience(next, actorId) ?? [actorId],
          });
          continue;
        }
        const impact = p.steps[i].narrativeImpact;
        if (impact) {
          const outcome = applyStoryImpact(next, actorId, turnId, segment.index, impact, input);
          if (outcome.error) return reject(outcome.error);
          next = recordNpcEvents(
            next,
            outcome.state,
            outcome.events,
            `impact:${turnId}:${segment.index}`,
          ).state;
          events.push(...outcome.events);
          push({
            kind: 'outcome',
            channel: input.channel,
            authorId: actorId,
            code: `NARRATIVE_${impact.effect.toUpperCase()}`,
            text: narrativeImpactOutcomeText(
              impact.effect === 'harm' &&
                actorLifeState(next.entities[impact.targetId]) === 'unconscious'
                ? 'unconscious'
                : impact.effect,
              input.replyLocale,
            ),
            audienceIds: audience,
          });
          continue;
        }
        const rawAction = p.steps[i].action;
        const proposed =
          rawAction?.targetId === 'new_item'
            ? { ...rawAction, targetId: `prop-${turnId}` }
            : rawAction;
        if (!proposed) continue; // Descriptive emote, not a mechanically completed action.
        const resolved =
          proposed.kind === 'travel' && proposed.targetId === 'new_scene'
            ? { ...proposed, targetId: `scene-${turnId}` }
            : proposed;
        if (proposed.kind === 'drop') {
          const candidates = storyItemPlacementContext(next, actorId, segment.text, input);
          const quoted = context.itemPlacementPolicy?.segmentCandidates.find(
            (entry) => entry.segmentIndex === segment.index,
          );
          if (
            candidates.readset.mapId !== quoted?.readset.mapId ||
            !candidates.items.some(
              (item) =>
                item.id === proposed.targetId &&
                item.revision === quoted?.items.find((entry) => entry.id === item.id)?.revision &&
                item.points.some(
                  (point) => point.x === proposed.target?.x && point.y === proposed.target?.y,
                ),
            )
          )
            return reject('FORBIDDEN');
        }
        if (proposed.kind === 'give') {
          const candidates = storyItemTransferContext(next, actorId, segment.text);
          if (
            !candidates.items.some((item) => item.id === proposed.itemId) ||
            !candidates.recipients.some(
              (recipient) =>
                recipient.id === proposed.targetId && recipient.reachable && recipient.hasCapacity,
            )
          )
            return reject('FORBIDDEN');
        }
        const action = proposed.kind === 'approach' ? null : allowedAction(next, actorId, resolved);
        if (!action && proposed.kind !== 'approach') return reject('FORBIDDEN');
        const outcome =
          proposed.kind === 'pick_up'
            ? applyStoryPickup(next, actorId, proposed.targetId!, segment.text, input)
            : proposed.kind === 'travel'
              ? proposed.targetId === 'new_scene' || !hasPosition(next.entities[actorId])
                ? travelToLocation(next, actorId, resolved.targetId!)
                : applyStoryOrderedAction(next, actorId, action!, input)
              : proposed.kind === 'approach'
                ? approachStoryNpc(next, actorId, resolveNpc(proposed.targetId!))
                : applyStoryOrderedAction(next, actorId, action!, input);
        if (outcome.error && (!action || !knownFailure(segment.index, action, outcome.error)))
          return unsupported();
        if (outcome.error === 'OUT_OF_RANGE' || outcome.error === 'PATH_BLOCKED')
          return reject(outcome.error);
        if (!outcome.error) {
          if (
            proposed.kind === 'travel' &&
            proposed.targetId === 'new_scene' &&
            options.prepareTravelPlacement
          ) {
            try {
              outcome.state = options.prepareTravelPlacement(outcome.state);
            } catch {
              return reject('INVALID_ACTION');
            }
          }
          next = recordNpcEvents(
            next,
            outcome.state,
            outcome.events,
            `turn:${turnId}:${segment.index}`,
          ).state;
          events.push(...outcome.events);
          if (proposed.kind === 'give' && proposed.itemId)
            transferredItems.add(`${proposed.itemId}:${proposed.targetId}`);
          if (proposed.kind === 'drop' && proposed.targetId) placedItems.add(proposed.targetId);
        }
        push({
          kind: 'outcome',
          channel: input.channel,
          authorId: actorId,
          code: storyContactOutcomeCode(outcome),
          // Hearers may not see the target or the giver's private inventory.
          ...(action ? { action: { kind: storyActionSchema.parse(action).kind } } : {}),
          audienceIds: audience,
        });
      } else if (p.steps[i].reply && p.steps[i].replyNpcId) {
        const npcId = resolveNpc(p.steps[i].replyNpcId!);
        const npc = next.entities[npcId];
        const committedImpact = next.narrativeCanon?.turns.find(
          (entry) => entry.id === turnId,
        )?.impact;
        const canOmitAdvisoryReply =
          (!!committedImpact && committedImpact.segmentIndex < segment.index) ||
          placedItems.size > 0;
        if (
          npc?.kind !== 'npc' ||
          !isActorConscious(npc) ||
          !visible(next, next.entities[actorId], npc) ||
          !canNpcHear(
            next,
            npc,
            next.entities[actorId],
            npcSpeechHearingRange({ channel: input.channel, text: segment.text }),
          )
        ) {
          if (!canOmitAdvisoryReply) return reject('OUT_OF_RANGE');
          advisoryReplyOmitted = true;
          const sourceError = admitCurrentSpeech();
          if (sourceError) return reject(sourceError);
          continue;
        }
        const variant = context.sceneSpeakerImpactVariants?.find(
          (entry) =>
            committedImpact &&
            entry.afterImpact.segmentIndex === committedImpact.segmentIndex &&
            entry.afterImpact.targetId === committedImpact.targetId &&
            entry.afterImpact.effect === committedImpact.effect &&
            entry.changes.speechHash === p.steps[i].replyContextHash,
        );
        const base =
          variant &&
          [...(context.sceneSpeakers ?? []), ...(context.sceneSpeakerImpactBases ?? [])].find(
            (entry) => entry.speechHash === variant.baseSpeechHash,
          );
        const preview =
          base && variant
            ? restoreImpactVoice(base, variant)
            : p.steps[i].replyNpcId === 'new_npc'
              ? undefined
              : context.sceneSpeakers?.find(
                  (voice) => voice.npcId === npcId && voice.segmentIndex === segment.index,
                );
        let spoken: ReturnType<typeof safeSpeech>;
        try {
          spoken = safeSpeech(
            next,
            actorId,
            npcId,
            input.channel,
            segment,
            turnId,
            preview?.observationIds,
            input.replyLocale,
            input.channel === 'say',
            privateAudience,
          );
        } catch {
          if (!canOmitAdvisoryReply) return reject('FORBIDDEN');
          advisoryReplyOmitted = true;
          const sourceError = admitCurrentSpeech();
          if (sourceError) return reject(sourceError);
          continue;
        }
        if (p.steps[i].replyNpcId === 'new_npc') {
          if (!p.narrative?.newNpc || p.steps[i].replyContextHash) return reject('FORBIDDEN');
        } else {
          if (
            !preview ||
            preview.npcId !== npcId ||
            preview.segmentIndex !== segment.index ||
            p.steps[i].replyContextHash !== preview.speechHash ||
            directorVoice(spoken.context).speechHash !== preview.speechHash
          ) {
            if (!canOmitAdvisoryReply) return reject('STALE_STATE');
            advisoryReplyOmitted = true;
            const sourceError = admitCurrentSpeech();
            if (sourceError) return reject(sourceError);
            continue;
          }
        }
        entries[entries.length - 1].sourceId = spoken.sourceId;
        next = spoken.state;
        events.push(...spoken.events);
        const response = commitNpcPublicUtterance(next, npcId, {
          ...p.steps[i].reply!,
          audienceLimit: privateAudience,
          allowAudibleRecipient: true,
          channel: input.channel,
          recipientId: actorId,
          replyLocale: input.replyLocale ?? 'en',
          observationIds: spoken.context.observationIds,
          requestedFactIds: spoken.context.requestedFactIds,
          contextHash: spoken.context.speechHash,
          replyToObservationId: spoken.context.replyToObservationId,
        });
        if (response.error) {
          if (!canOmitAdvisoryReply) return reject(response.error);
          advisoryReplyOmitted = true;
          continue; // Source speech is admitted; stale advisory reply is omitted, not queued.
        }
        const responseUtterance = response.state.npcUtterances?.find(
          (u) => u.speakerId === npcId && !next.npcUtterances?.some((old) => old.id === u.id),
        );
        const sourceId = responseUtterance?.id;
        next = response.state;
        events.push(...response.events);
        push({
          kind: 'npc_reply',
          channel: input.channel,
          sourceId,
          authorId: npcId,
          authorLabel: npc.label,
          ...p.steps[i].reply!,
          audienceIds: responseUtterance?.audienceIds ?? [],
        });
      } else if (segment.kind === 'speech') {
        const sourceError = admitCurrentSpeech();
        if (sourceError) return reject(sourceError);
      }
    }
    if (
      claimedTransfers.some(
        (claim) => !transferredItems.has(`${claim.itemId}:${claim.recipientId}`),
      )
    )
      return unsupported();
    if (claimedPlacements.some((id) => !placedItems.has(id))) return unsupported();
    const admittedEncounter = next.narrativeCanon!.turns.find(
      (entry) => entry.id === turnId,
    )?.sceneEncounter;
    if (admittedEncounter && p.steps.some((step) => step.replyNpcId === admittedEncounter.npcId))
      return reject('FORBIDDEN');
    let admittedNarration = admittedEncounter
      ? sceneEncounterOutcomeText(
          next.entities[admittedEncounter.npcId].label ?? admittedEncounter.npcId,
          input.replyLocale,
        )
      : p.narrative!.narration;
    if (admittedEncounter)
      next.narrativeCanon!.turns.find((entry) => entry.id === turnId)!.narration =
        admittedNarration;
    if (advisoryReplyOmitted) {
      // Generated prose may repeat the unadmitted reply. Keep the real consequence,
      // but never canonize fabricated words from an omitted advisory voice.
      const admitted = next.narrativeCanon!.turns.find((entry) => entry.id === turnId)!;
      const impact = admitted.impact;
      admittedNarration = impact
        ? narrativeImpactOutcomeText(
            impact.effect === 'harm' && impact.lifeStateAfter === 'unconscious'
              ? 'unconscious'
              : impact.effect,
            input.replyLocale,
          )
        : storyItemPlacementOutcomeText(input.replyLocale);
      admitted.narration = admittedNarration;
    }
    if (
      placedItems.size &&
      inconsistentStoryPlacementNarration(
        admittedNarration,
        referencedPlacementItems.filter((item) => placedItems.has(item.id)),
      )
    ) {
      // A detected invented surface/trajectory cannot be canonized. Preserve
      // ordinary grounded prose; this fallback records only the admitted result.
      admittedNarration = storyItemPlacementOutcomeText(input.replyLocale, placedItems.size);
      next.narrativeCanon!.turns.find((entry) => entry.id === turnId)!.narration =
        admittedNarration;
    }
    // A scene-cut narration can contain facts from both sides of the journey.
    // Neither source nor destination bystanders are authorized for that combined prose.
    const origin = state.entities[actorId],
      destination = next.entities[actorId];
    const scopedTravel =
      (origin.spatialMode === 'location_only' || destination.spatialMode === 'location_only') &&
      (origin.mapId !== destination.mapId ||
        origin.sceneId !== destination.sceneId ||
        !!p.travelIntent ||
        p.steps.some((step) => step.action?.kind === 'travel'));
    const narrationAudience = scopedTravel
      ? [actorId]
      : (privateAudience ?? narrativeSceneAudience(state, actorId) ?? ['*']);
    if (scopedTravel) {
      const admitted = next.narrativeCanon!.turns.find((entry) => entry.id === turnId)!;
      admitted.audienceIds = [actorId];
      admitted.channel = input.channel === 'whisper' ? 'whisper' : 'public';
    }
    push({
      kind: 'narration',
      channel: input.channel,
      text: admittedNarration,
      audienceIds: narrationAudience,
    });
  } else {
    const npcId = input.targetNpcId!;
    for (const [i, segment] of context.segments.entries()) {
      const step = p.steps[i];
      const audience =
        segment.kind === 'speech'
          ? npcSpeechListenerIds(next, actorId, {
              channel: input.channel,
              text: segment.text,
            }).filter(
              (id) =>
                hasPosition(next.entities[actorId]) ||
                input.channel !== 'whisper' ||
                id === actorId ||
                id === npcId,
            )
          : input.channel === 'whisper'
            ? [actorId, npcId]
            : listeners(next, actorId);
      push({
        kind: segment.kind,
        channel: input.channel,
        authorId: actorId,
        authorLabel: next.entities[actorId].label,
        text: segment.text,
        audienceIds: audience,
      });
      if (segment.kind === 'attempt') {
        const action = allowedAction(next, actorId, step.action);
        if (!action) return reject('FORBIDDEN');
        const r =
          action.kind === 'pick_up'
            ? applyStoryPickup(next, actorId, action.targetId!, segment.text, input)
            : applyAction(next, actorId, action);
        if (r.error && !knownFailure(segment.index, action, r.error)) return unsupported();
        if (
          r.error === 'OUT_OF_RANGE' ||
          r.error === 'TARGET_UNAVAILABLE' ||
          r.error === 'INVALID_ACTION'
        )
          return reject(r.error);
        const publicAudience = listeners(next, actorId);
        if (!r.error) {
          next = recordNpcEvents(next, r.state, r.events, `turn:${turnId}:${segment.index}`).state;
          events.push(...r.events);
        }
        push({
          kind: 'outcome',
          channel: 'say',
          authorId: actorId,
          code: storyContactOutcomeCode(r),
          action: { kind: storyActionSchema.parse(step.action).kind },
          audienceIds: publicAudience,
        });
      } else {
        let spoken: ReturnType<typeof safeSpeech>;
        try {
          spoken = safeSpeech(
            next,
            actorId,
            npcId,
            input.channel,
            segment,
            turnId,
            context.dialogues.find((d) => d.segmentIndex === segment.index)?.observationIds,
            input.replyLocale,
          );
        } catch {
          return reject();
        }
        const expected = context.dialogues.find((d) => d.segmentIndex === segment.index);
        if (!expected || spoken.context.speechHash !== expected.speechHash) return reject();
        entries[entries.length - 1].sourceId = spoken.sourceId;
        next = spoken.state;
        events.push(...spoken.events);
        const r = commitNpcPublicUtterance(next, npcId, {
          ...step.reply!,
          channel: input.channel,
          recipientId: actorId,
          observationIds: spoken.context.observationIds,
          requestedFactIds: spoken.context.requestedFactIds,
          contextHash: spoken.context.speechHash,
          replyToObservationId: spoken.context.replyToObservationId,
          replyLocale: input.replyLocale,
        });
        if (r.error) return reject(r.error);
        const responseUtterance = r.state.npcUtterances?.find(
          (u) => u.speakerId === npcId && !next.npcUtterances?.some((old) => old.id === u.id),
        );
        const sourceId = responseUtterance?.id;
        next = r.state;
        events.push(...r.events);
        push({
          sourceId,
          kind: 'npc_reply',
          channel: input.channel,
          authorId: npcId,
          authorLabel: next.entities[npcId].label,
          ...('text' in step.reply! ? { text: step.reply!.text } : { code: 'acknowledged' }),
          audienceIds: responseUtterance?.audienceIds ?? [],
        });
      }
    }
  }
  let pendingTravel: StoryTravelIntent | undefined;
  if (p.travelIntent) {
    const destination = resolveTravelDestination(next, p.travelIntent.destinationName);
    if (!destination.ambiguous && !destination.mapId) pendingTravel = p.travelIntent;
    else if (destination.mapId) {
      const outcome = travelToLocation(next, actorId, destination.mapId);
      if (!outcome.error) {
        next = recordNpcEvents(
          next,
          outcome.state,
          outcome.events,
          `turn:${turnId}:semantic-travel`,
        ).state;
        events.push(...outcome.events);
        actions.push({
          segmentIndex: p.travelIntent.segmentIndex,
          action: { kind: 'travel', targetId: destination.mapId },
        });
      }
      push({
        kind: 'outcome',
        channel: 'say',
        authorId: actorId,
        code: outcome.error ?? 'ACTION_SUCCEEDED',
        audienceIds: [actorId],
        action: { kind: 'travel' },
      });
    } else
      push({
        kind: 'outcome',
        channel: 'say',
        authorId: actorId,
        code: 'AMBIGUOUS',
        audienceIds: [actorId],
      });
  }
  return { state: next, events, entries, actions, ...(pendingTravel ? { pendingTravel } : {}) };
}

/** Complete only a short, collision-checked approach explicitly proposed for a player attempt.
 * This scene cut does not fast-forward unrelated actors or claim queued movement completed. */
function approachStoryNpc(state: GameState, actorId: string, npcId: string): GameResult {
  const actor = state.entities[actorId],
    npc = state.entities[npcId];
  const reject = (error: GameResult['error']): GameResult => ({ state, events: [], error });
  if (
    !actor ||
    actor.kind !== 'player' ||
    npc?.kind !== 'npc' ||
    actor.encounterId ||
    npc.encounterId ||
    !visible(state, actor, npc)
  )
    return reject('FORBIDDEN');
  if (!hasPosition(actor) || !hasPosition(npc)) return reject('WRONG_MODE');
  if (footprintDistance(actor, npc) <= 1) return { state, events: [] };
  if (state.turnController) return reject('WRONG_MODE');
  const candidates: { x: number; y: number }[] = [];
  for (let y = actor.y - 8; y <= actor.y + 8; y++)
    for (let x = actor.x - 8; x <= actor.x + 8; x++)
      if (
        footprintDistance({ ...actor, x, y }, npc) === 1 &&
        walkable(state, actor.mapId, { x, y }, actorId, true)
      )
        candidates.push({ x, y });
  const paths = candidates
    .map((p) => findPath(state, actor.mapId, actor, p, actorId, true))
    .filter((p): p is NonNullable<typeof p> => !!p && p.length <= 8)
    .filter((path) =>
      path.every((p) =>
        occupiedCells({ ...actor, ...p }).every(
          (cell) =>
            !Object.values(state.encounters).some(
              (e) =>
                e.phase === 'planning' &&
                e.mapId === actor.mapId &&
                cell.x >= e.area.x &&
                cell.y >= e.area.y &&
                cell.x < e.area.x + e.area.width &&
                cell.y < e.area.y + e.area.height,
            ),
        ),
      ),
    )
    .sort((a, b) => a.length - b.length);
  const path = paths[0];
  if (!path?.length) return reject('PATH_BLOCKED');
  const next = structuredClone(state),
    moved = next.entities[actorId];
  Object.assign(moved, path[path.length - 1]);
  moved.path = [];
  moved.movementGeneration = (moved.movementGeneration ?? 0) + 1;
  moved.revision++;
  next.revision++;
  return { state: next, events: [{ kind: 'actor.moved', actorId, mapId: actor.mapId }] };
}

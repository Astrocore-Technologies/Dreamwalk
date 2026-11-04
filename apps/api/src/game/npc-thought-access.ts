import type { GameState, NpcObservation } from '@dreamwalk/contracts';
import { visible } from '@dreamwalk/game-core';
import { fail } from '../errors';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
const ids = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((id) => typeof id === 'string') ? value : undefined;

/** Information-flow ACL, not a model-provided claim about its output. A thought
 * inherits the most restrictive source audience, even if its wording looks harmless.
 * No owner/GM bypass: another player's whisper stays private after they leave. */
export function npcThoughtAudience(
  state: GameState,
  npcId: string,
  purpose: string,
  context: RecordValue,
): string[] {
  let audience = Object.values(state.entities)
    .filter((entity) => entity.kind === 'player')
    .map((entity) => entity.id);
  const restrict = (allowed: string[] | undefined) => {
    audience = allowed ? audience.filter((id) => allowed.includes(id)) : [];
  };
  if (purpose === 'speech') restrict(ids(context.audienceIds));
  else if (purpose !== 'plan') return [];

  const observations = new Map<string, NpcObservation>();
  for (const observation of state.npcBrains?.[npcId]?.living?.observations ?? [])
    observations.set(observation.id, observation);
  const restrictObservation = (value: unknown) => {
    const observation = record(value);
    if (!observation || typeof observation.id !== 'string') {
      restrict(undefined);
      return;
    }
    if (observation.disclosure === 'private') {
      // An authored secret belongs to the source author. It does not grant
      // access to any player-originated private utterance or observation.
      if (observation.kind !== 'authored_fact') restrict([]);
    } else if (observation.disclosure === 'participants') restrict(ids(observation.audienceIds));
    else if (observation.disclosure !== 'public') restrict(undefined);
  };
  // Keep the full prepared candidate conservative as well: an exact-count pack
  // may choose a larger history than the preliminary envelope.
  const envelopes = [context, record(context.textContextCandidate)].filter(
    (value): value is RecordValue => !!value,
  );
  for (const envelope of envelopes)
    for (const key of ['observations', 'archivedEpisodes', 'history'])
      if (Array.isArray(envelope[key]))
        for (const value of envelope[key]) {
          const observation = record(value);
          if (observation && typeof observation.id === 'string' && observation.disclosure)
            observations.set(observation.id, observation as unknown as NpcObservation);
        }

  for (const envelope of envelopes) {
    if (purpose === 'plan') {
      for (const key of ['observations', 'archivedEpisodes', 'history'])
        if (Array.isArray(envelope[key]))
          for (const observation of envelope[key]) restrictObservation(observation);
      const previous = record(envelope.previousCognition);
      if (previous) restrict(ids(previous.audienceIds));
      // Derived memories/relationships can carry information whose original
      // episode was trimmed from the prompt. Resolve every retained evidence ID.
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
          for (const child of value) visit(child);
          return;
        }
        const object = record(value);
        if (!object) return;
        for (const [key, child] of Object.entries(object)) {
          if (key === 'evidenceIds' || key === 'observationIds') {
            const evidence = ids(child);
            if (!evidence) restrict(undefined);
            else for (const id of evidence) restrictObservation(observations.get(id));
          } else if (key !== 'textContextCandidate') visit(child);
        }
      };
      visit(envelope);
    }
  }
  return [...new Set(audience)].sort();
}

function thoughtRequiresSourceAuthor(
  state: GameState,
  npcId: string,
  purpose: string,
  context: RecordValue,
): boolean {
  if (purpose !== 'plan') return false;
  const observations = new Map(
    (state.npcBrains?.[npcId]?.living?.observations ?? []).map((value) => [value.id, value]),
  );
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(visit);
    const object = record(value);
    if (!object) return false;
    if (object.kind === 'authored_fact' && object.disclosure === 'private') return true;
    if (object.requiresSourceAuthor === true) return true;
    for (const key of ['evidenceIds', 'observationIds'])
      if (
        ids(object[key])?.some((id) => {
          const source = observations.get(id);
          return source?.kind === 'authored_fact' && source.disclosure === 'private';
        })
      )
        return true;
    // Private personality, authored goals and supporting-character flavor are
    // not covered by episode ACLs and can themselves contain story secrets.
    if (
      object.personality ||
      object.goalDefinitions ||
      record(object.publicIdentity)?.untrustedPersonalityFlavor
    )
      return true;
    return Object.values(object).some(visit);
  };
  return visit(context);
}

/** Called only after a validated cognition output was committed. Never copy this
 * metadata to an observation, event, NPC prompt for another actor, or shared HUD. */
export function stampNpcThoughtAudience(
  state: GameState,
  npcId: string,
  purpose: string,
  context: RecordValue,
): GameState {
  if (!state.npcBrains?.[npcId]?.living?.cognition) return state;
  const next = structuredClone(state);
  next.npcBrains![npcId].living!.cognition!.audienceIds = npcThoughtAudience(
    state,
    npcId,
    purpose,
    context,
  );
  next.npcBrains![npcId].living!.cognition!.requiresSourceAuthor = thoughtRequiresSourceAuthor(
    state,
    npcId,
    purpose,
    context,
  );
  return next;
}

export function projectNpcInnerThought(
  state: GameState,
  actorId: string,
  npcId: string,
  sourceAuthorAccess = false,
) {
  const actor = state.entities[actorId],
    npc = state.entities[npcId];
  if (
    !actor ||
    actor.kind !== 'player' ||
    !npc ||
    npc.kind !== 'npc' ||
    !visible(state, actor, npc)
  )
    fail(403, 'FORBIDDEN', 'FORBIDDEN');
  const thought = state.npcBrains?.[npcId]?.living?.cognition;
  if (!thought) return { npcId, thought: null };
  if (!thought.audienceIds?.includes(actorId)) fail(403, 'FORBIDDEN', 'FORBIDDEN');
  if (thought.requiresSourceAuthor && !sourceAuthorAccess) fail(403, 'FORBIDDEN', 'FORBIDDEN');
  return {
    npcId,
    thought: {
      text: thought.innerThought,
      roundId: thought.roundId ?? null,
      roundNumber: thought.roundNumber ?? null,
      tick: thought.tick,
    },
  };
}

import {
  npcBeliefRevisionSchema,
  gameActionSchema,
  type GameState,
  type GameResult,
  type GameAction,
  type NpcBeliefRevision,
} from '@dreamwalk/contracts';
import { visible, applyAction } from './index';
import { npcContextFingerprint } from './living';
/** A model may suggest a belief, but cannot manufacture evidence or promote hearsay to certainty. */
export function reviseNpcBelief(state: GameState, npcId: string, input: unknown): GameResult {
  const p = npcBeliefRevisionSchema.safeParse(input),
    m = state.npcBrains?.[npcId]?.living;
  if (!p.success || !m) return { state, events: [], error: 'INVALID_ACTION' };
  const x = p.data,
    source = x.evidenceIds.map((id) => m.observations.find((o) => o.id === id));
  if (new Set(x.evidenceIds).size !== x.evidenceIds.length || source.some((o) => !o))
    return { state, events: [], error: 'FORBIDDEN' };
  const expectedKinds: Record<NpcBeliefRevision['predicate'], string[]> = {
    item_missing: ['item_missing'],
    took_item: ['item_taken', 'claim'],
    heard_noise: ['noise'],
    needs_help: ['addressed'],
  };
  if (source.some((o) => !expectedKinds[x.predicate].includes(o!.kind)))
    return { state, events: [], error: 'FORBIDDEN' };
  const old = x.beliefId ? m.beliefs.find((b) => b.id === x.beliefId) : undefined;
  if (
    x.subjectId &&
    !(x.status === 'disputed' && old?.subjectId === x.subjectId) &&
    !source.some((o) => o!.actorId === x.subjectId)
  )
    return { state, events: [], error: 'FORBIDDEN' };
  if (x.targetId && !source.some((o) => o!.targetId === x.targetId))
    return { state, events: [], error: 'FORBIDDEN' };
  if (x.confidence === 'certain' && source.some((o) => o!.confidence !== 'witnessed'))
    return { state, events: [], error: 'FORBIDDEN' };
  if (x.reason === 'direct_evidence' && !source.some((o) => o!.confidence === 'witnessed'))
    return { state, events: [], error: 'FORBIDDEN' };
  if (x.reason === 'reported_claim' && !source.some((o) => o!.confidence === 'reported'))
    return { state, events: [], error: 'FORBIDDEN' };
  if (
    (x.beliefId && !old) ||
    (old ? old.revision !== x.expectedRevision : x.expectedRevision !== 0)
  )
    return { state, events: [], error: 'STALE_STATE' };
  if (x.status === 'disputed' || x.reason === 'contradiction') {
    if (
      !old ||
      !source.some(
        (o) =>
          o!.confidence === 'witnessed' &&
          o!.targetId === old.targetId &&
          o!.actorId !== old.subjectId,
      )
    )
      return { state, events: [], error: 'FORBIDDEN' };
  }
  const s = structuredClone(state),
    next = s.npcBrains![npcId].living!,
    id = x.beliefId ?? `belief-${npcContextFingerprint(x)}`;
  const updated = {
    id,
    subjectId: x.subjectId,
    targetId: x.targetId,
    predicate: x.predicate,
    confidence: x.confidence,
    evidenceIds: [...x.evidenceIds],
    status: x.status,
    revision: (old?.revision ?? -1) + 1,
    reason: x.reason,
  };
  if (old) next.beliefs = next.beliefs.map((b) => (b.id === id ? updated : b));
  else if (!next.beliefs.some((b) => b.id === id))
    next.beliefs = [...next.beliefs, updated].slice(-64);
  else return { state, events: [] };
  next.knowledgeRevision++;
  next.summary = undefined;
  s.revision++;
  return {
    state: s,
    events: [{ kind: 'npc.belief_revised', actorId: npcId, mapId: s.entities[npcId].mapId }],
  };
}
export interface PlayerTextIntent {
  id: string;
  actorId: string;
  text: string;
  action: GameAction;
  mapId: string;
  actorRevision: number;
  targetRevision?: number;
  itemRevision?: number;
  requiresConfirmation: true;
}
/** Narrow multilingual intent grammar; unknown prose is dialogue, never executable code. */
export function parsePlayerTextAction(
  state: GameState,
  actorId: string,
  text: string,
): GameAction | null {
  const actor = state.entities[actorId];
  if (actor?.kind !== 'player' || typeof text !== 'string' || !text.trim() || text.length > 1000)
    return null;
  const normalized = text.trim().toLowerCase(),
    patterns: [RegExp, GameAction['kind']][] = [
      [/^(open|открой|открываю|відкрий|відкриваю)\s+(.+)$/u, 'open'],
      [/^(close|закрой|закрываю|закрий|закриваю)\s+(.+)$/u, 'close'],
      [/^(inspect|осмотри|осматриваю|оглянь|оглядаю)\s+(.+)$/u, 'inspect'],
      [/^(take|pick up|возьми|беру|поднимаю|візьми|піднімаю)\s+(.+)$/u, 'pick_up'],
      [/^(knock|постучи|постукай)\s+(.+)$/u, 'knock'],
    ];
  const unique = <T>(values: T[]): T | undefined => (values.length === 1 ? values[0] : undefined);
  let action: GameAction | undefined;
  if (/^(wait|жди|жду|чекай|чекаю)$/u.test(normalized)) action = { kind: 'wait' };
  for (const [pattern, kind] of patterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    const target = unique(
      Object.values(state.entities).filter(
        (e) => visible(state, actor, e) && [e.id, e.label?.toLowerCase()].includes(match[2]),
      ),
    );
    if (target) action = { kind, targetId: target.id };
    break;
  }
  const give = normalized.match(/^(give|отдай|віддай)\s+(.+)\s+(?:to|кому|до)\s+(.+)$/u);
  if (give) {
    const item = unique(
      (actor.inventory ?? [])
        .map((id) => state.entities[id])
        .filter((e) => [e.id, e.label?.toLowerCase()].includes(give[2])),
    );
    const target = unique(
      Object.values(state.entities).filter(
        (e) =>
          ['npc', 'player'].includes(e.kind) &&
          visible(state, actor, e) &&
          [e.id, e.label?.toLowerCase()].includes(give[3]),
      ),
    );
    if (item && target) action = { kind: 'give', targetId: target.id, itemId: item.id };
  }
  if (!action) return null;
  return action;
}
export function proposePlayerTextIntent(
  state: GameState,
  actorId: string,
  text: string,
): PlayerTextIntent | null {
  const action = parsePlayerTextAction(state, actorId, text);
  return action ? proposePlayerActionIntent(state, actorId, text, action) : null;
}

export function confirmPlayerTextIntent(
  state: GameState,
  actorId: string,
  proposal: PlayerTextIntent,
  confirmed: boolean,
): GameResult {
  if (
    !proposal ||
    typeof proposal !== 'object' ||
    typeof proposal.id !== 'string' ||
    typeof proposal.text !== 'string'
  )
    return { state, events: [], error: 'INVALID_ACTION' };
  if (confirmed !== true) return { state, events: [], error: 'FORBIDDEN' };
  if (proposal.actorId !== actorId) return { state, events: [], error: 'FORBIDDEN' };
  const current = proposePlayerActionIntent(state, actorId, proposal.text, proposal.action);
  if (
    !current ||
    current.id !== proposal.id ||
    npcContextFingerprint(current) !== npcContextFingerprint(proposal)
  )
    return { state, events: [], error: 'STALE_STATE' };
  return applyAction(state, actorId, current.action);
}

/** Provider and deterministic grammar share the same strict server-side proposal/readset builder. */
export function proposePlayerActionIntent(
  state: GameState,
  actorId: string,
  text: string,
  input: unknown,
): PlayerTextIntent | null {
  const p = gameActionSchema.safeParse(input),
    actor = state.entities[actorId];
  if (
    !p.success ||
    actor?.kind !== 'player' ||
    typeof text !== 'string' ||
    !text.trim() ||
    text.length > 1000
  )
    return null;
  const action = p.data;
  if (
    ![
      'wait',
      'move_to',
      'inspect',
      'open',
      'close',
      'unlock',
      'lock',
      'pick_up',
      'give',
      'knock',
      'talk',
      'distract',
    ].includes(action.kind)
  )
    return null;
  if (
    action.targetId &&
    (!state.entities[action.targetId] || !visible(state, actor, state.entities[action.targetId]))
  )
    return null;
  if (action.itemId && state.entities[action.itemId]?.ownerId !== actorId) return null;
  // Dry-run pure reducer validates range, ownership and mode; its returned state is deliberately discarded.
  const checked = applyAction(state, actorId, action);
  if (checked.error) return null;
  const proposal = {
    actorId,
    text: text.trim(),
    action,
    mapId: actor.mapId,
    actorRevision: actor.revision,
    targetRevision: action.targetId ? state.entities[action.targetId]?.revision : undefined,
    itemRevision: action.itemId ? state.entities[action.itemId]?.revision : undefined,
    requiresConfirmation: true as const,
  };
  return { id: `intent-${npcContextFingerprint(proposal)}`, ...proposal };
}

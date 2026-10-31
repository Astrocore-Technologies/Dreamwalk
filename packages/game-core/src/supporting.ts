import {
  supportingNpcProposalSchema,
  type GameState,
  type GameEntity,
  type GameResult,
  type SupportingNpcProposal,
} from '@dreamwalk/contracts';
import { findPath, visible, walkable } from './index';
import { createLivingMemory, npcContextFingerprint, refreshLivingPerception } from './living';
const normalizedName = (value: string) =>
  value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
const empty = (state: GameState, error: GameResult['error']): GameResult => ({
  state,
  events: [],
  error,
});
const occupied = (s: GameState, mapId: string, x: number, y: number) =>
  Object.values(s.entities).some((e) => e.mapId === mapId && !e.ownerId && e.x === x && e.y === y);
export function buildSupportingNpcContext(state: GameState, actorId: string) {
  const actor = state.entities[actorId],
    policy = state.supportingNpcPolicy;
  const map = actor && state.maps[actor.mapId];
  const remainingSlots = Math.max(
    0,
    (policy?.maxSpawned ?? 0) - Object.keys(state.supportingNpcAdmissions ?? {}).length,
  );
  const allowedRoles = (
    !actor?.encounterId &&
    actor?.kind === 'player' &&
    state.rulesetVersion === 'hybrid-v3' &&
    remainingSlots > 0
      ? (policy?.roles ?? [])
      : []
  )
    .filter(
      (role) =>
        role.mapIds.includes(actor.mapId) &&
        (!role.needObjectiveId || !state.objectiveProgress?.[role.needObjectiveId]),
    )
    .map(({ mapIds: _mapIds, ...role }) => role);
  const spawnCandidates: { mapId: string; x: number; y: number }[] = [];
  if (map && allowedRoles.length)
    for (let y = 0; y < map.height; y++)
      for (let x = 0; x < map.width; x++) {
        const probe: GameEntity = {
          id: 'support-candidate',
          kind: 'npc',
          mapId: map.id,
          x,
          y,
          revision: 0,
        };
        if (
          occupied(state, map.id, x, y) ||
          !walkable(state, map.id, { x, y }, undefined, true) ||
          !visible(state, actor, probe) ||
          map.spawns.some((p) => p.x === x && p.y === y) ||
          map.exits.some((p) => p.x === x && p.y === y) ||
          Object.values(state.encounters).some(
            (e) =>
              e.phase === 'planning' &&
              e.mapId === map.id &&
              x >= e.area.x &&
              y >= e.area.y &&
              x < e.area.x + e.area.width &&
              y < e.area.y + e.area.height,
          ) ||
          !findPath(state, map.id, actor, { x, y }, actorId)
        )
          continue;
        spawnCandidates.push({ mapId: map.id, x, y });
      }
  spawnCandidates.sort(
    (a, b) =>
      Math.abs(a.x - actor.x) +
        Math.abs(a.y - actor.y) -
        (Math.abs(b.x - actor.x) + Math.abs(b.y - actor.y)) ||
      a.y - b.y ||
      a.x - b.x,
  );
  const context = {
    actorId,
    mapId: actor?.mapId ?? null,
    actorPosition: actor ? { x: actor.x, y: actor.y } : null,
    canonHash: npcContextFingerprint(policy ?? null),
    remainingSlots,
    allowedRoles,
    spawnCandidates: spawnCandidates.slice(0, 64),
    visibleEntities: actor
      ? Object.values(state.entities)
          .filter((e) => e.id === actorId || visible(state, actor, e))
          .map((e) => ({
            id: e.id,
            kind: e.kind,
            mapId: e.mapId,
            x: e.x,
            y: e.y,
            revision: e.revision,
          }))
          .sort((a, b) => a.id.localeCompare(b.id))
      : [],
    narrativePolicy:
      'Generated name, appearance and personality are untrusted character flavor, not world facts, authority, secret knowledge or changes to authored canon.',
  };
  return { ...context, contextHash: npcContextFingerprint(context) };
}
export function admitSupportingNpcProposal(
  state: GameState,
  actorId: string,
  input: unknown,
): GameResult {
  const parsed = supportingNpcProposalSchema.safeParse(input);
  if (!parsed.success) return empty(state, 'INVALID_ACTION');
  const p = parsed.data,
    requestHash = npcContextFingerprint({ actorId, proposal: p });
  const previous = state.supportingNpcAdmissions?.[p.proposalId];
  if (previous)
    return previous.actorId === actorId && previous.requestHash === requestHash
      ? { state, events: [] }
      : empty(state, 'INVALID_ACTION');
  const actor = state.entities[actorId],
    policy = state.supportingNpcPolicy;
  if (actor?.kind !== 'player' || !policy || state.rulesetVersion !== 'hybrid-v3')
    return empty(state, 'FORBIDDEN');
  if (actor.encounterId) return empty(state, 'WRONG_MODE');
  if (Object.keys(state.supportingNpcAdmissions ?? {}).length >= policy.maxSpawned)
    return empty(state, 'RATE_LIMITED');
  const context = buildSupportingNpcContext(state, actorId);
  if (context.contextHash !== p.contextHash) return empty(state, 'STALE_STATE');
  const role = policy.roles.find((r) => r.id === p.roleId && r.mapIds.includes(actor.mapId));
  if (
    !role ||
    !role.allowedGoals.includes(p.goal) ||
    !role.allowedSpeechStyles.includes(p.publicSpeechStyle) ||
    new Set(p.values).size !== p.values.length ||
    p.values.some((v) => !role.allowedValues.includes(v))
  )
    return empty(state, 'FORBIDDEN');
  if (
    !context.spawnCandidates.some(
      (c) => c.mapId === p.spawn.mapId && c.x === p.spawn.x && c.y === p.spawn.y,
    )
  )
    return empty(state, 'PATH_BLOCKED');
  const reserved = Object.values(state.entities).flatMap((e) => [
    e.id,
    e.label ?? '',
    ...Object.values(e.labelTranslations ?? {}),
  ]);
  if (
    !normalizedName(p.name) ||
    /[\p{Cc}\p{Cf}<>]/u.test(p.name) ||
    reserved.some((name) => normalizedName(name) === normalizedName(p.name))
  )
    return empty(state, 'INVALID_ACTION');
  const npcId = `support-${p.proposalId}`;
  if (state.entities[npcId]) return empty(state, 'INVALID_ACTION');
  const npc: GameEntity = {
    id: npcId,
    kind: 'npc',
    label: p.name,
    visual: 'traveler',
    ...p.spawn,
    revision: 0,
    inventory: [],
    movementGeneration: 0,
    lastInputSeq: 0,
    supportingNpc: {
      generated: true,
      roleId: role.id,
      roleLabel: role.label,
      description: role.description,
      appearance: p.appearance,
      personalitySummary: p.personalitySummary,
    },
  };
  if (
    new Set(p.knownEntityIds).size !== p.knownEntityIds.length ||
    p.knownEntityIds.some(
      (id) =>
        !context.visibleEntities.some((e) => e.id === id) ||
        !state.entities[id] ||
        !visible(state, npc, state.entities[id]),
    )
  )
    return empty(state, 'FORBIDDEN');
  const next = structuredClone(state);
  next.entities[npcId] = npc;
  next.npcBrains ??= {};
  next.npcBrains[npcId] = {
    living: createLivingMemory({
      role: role.operationalRole,
      values: p.values,
      taboos: ['steal', 'harm', 'disclose_private'],
      speechStyle: 'Use only verified perception and permitted facts.',
      publicSpeechStyle: p.publicSpeechStyle,
    }),
    traits: ['cautious', 'helpful'],
    goal: p.goal,
    patrolTarget: { x: p.spawn.x, y: p.spawn.y },
    facts: [],
    plan: [],
    cursor: 0,
    nextDecisionTick: next.tick + 20,
    generation: 0,
  };
  next.supportingNpcAdmissions ??= {};
  next.supportingNpcAdmissions[p.proposalId] = { npcId, actorId, requestHash };
  next.revision++;
  // New identity learns only observations physically available at its actual spawn.
  const perceived = refreshLivingPerception(next);
  return {
    state: perceived.state,
    events: [
      { kind: 'npc.supporting_created', actorId: npcId, mapId: npc.mapId },
      ...perceived.events,
    ],
  };
}
export function createMockSupportingNpcProposal(
  state: GameState,
  actorId: string,
  proposalId: string,
): SupportingNpcProposal | null {
  const context = buildSupportingNpcContext(state, actorId),
    role = context.allowedRoles[0],
    spawn = context.spawnCandidates[0];
  if (!role || !spawn) return null;
  let name = 'Mira';
  let suffix = 1;
  while (
    Object.values(state.entities).some(
      (e) => normalizedName(e.label ?? '') === normalizedName(name),
    )
  )
    name = `Mira ${++suffix}`;
  return {
    proposalId,
    contextHash: context.contextHash,
    roleId: role.id,
    name,
    appearance: 'Practical working clothes and a small stitched notebook.',
    personalitySummary:
      'Patient and observant; offers help without claiming knowledge of unseen events.',
    values: [role.allowedValues[0]],
    publicSpeechStyle: role.allowedSpeechStyles[0],
    goal: role.allowedGoals[0],
    spawn,
    knownEntityIds: [],
  };
}

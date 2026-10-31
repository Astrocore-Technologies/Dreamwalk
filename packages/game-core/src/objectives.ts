import type {
  GameState,
  GameResult,
  ObjectiveCondition,
  ObjectiveProjection,
} from '@dreamwalk/contracts';

function satisfied(state: GameState, party: ReadonlySet<string>, condition: ObjectiveCondition) {
  if (condition.kind === 'party_reaches_map')
    return [...party].some((id) => state.entities[id]?.mapId === condition.mapId);
  if (condition.kind === 'party_owns_item') {
    const item = state.entities[condition.itemId];
    return (
      !!item &&
      item.kind === 'item' &&
      !!item.ownerId &&
      party.has(item.ownerId) &&
      !!state.entities[item.ownerId]?.inventory?.includes(item.id)
    );
  }
  const door = state.entities[condition.doorId];
  return (
    door?.kind === 'door' &&
    (condition.kind === 'door_open' ? door.open === true : door.locked === false)
  );
}
/** Only the authoritative writer supplies accepted, source-authorized participant ids. */
export function advanceObjectives(
  state: GameState,
  activePartyActorIds: readonly string[],
): GameResult {
  const party = new Set(activePartyActorIds.filter((id) => state.entities[id]?.kind === 'player'));
  if (!party.size || !state.objectives?.length) return { state, events: [] };
  const newlyAchieved = state.objectives.filter((objective) => {
    if (state.objectiveProgress?.[objective.id]) return false;
    const matches = objective.completion.conditions.map((condition) =>
      satisfied(state, party, condition),
    );
    return (
      matches.length > 0 &&
      (objective.completion.mode === 'all' ? matches.every(Boolean) : matches.some(Boolean))
    );
  });
  if (!newlyAchieved.length) return { state, events: [] };
  const next = structuredClone(state);
  next.objectiveProgress ??= {};
  for (const objective of newlyAchieved)
    next.objectiveProgress[objective.id] = { achievedTick: state.tick };
  next.revision++;
  return {
    state: next,
    events: newlyAchieved.map((objective) => ({
      kind: 'objective.achieved',
      targetId: objective.id,
    })),
  };
}

/** Public authored copy only. Never serialize conditions or unfinished epilogues. */
export function projectObjectives(state: GameState): ObjectiveProjection[] | undefined {
  if (!state.objectives?.length) return undefined;
  return state.objectives.map((objective) => {
    const progress = state.objectiveProgress?.[objective.id];
    const translations =
      objective.translations &&
      Object.fromEntries(
        Object.entries(objective.translations).map(([locale, copy]) => [
          locale,
          {
            title: copy.title,
            description: copy.description,
            ...(progress ? { epilogue: copy.epilogue } : {}),
          },
        ]),
      );
    return {
      id: objective.id,
      title: objective.title,
      description: objective.description,
      status: progress ? 'achieved' : 'active',
      ...(translations ? { translations } : {}),
      ...(progress ? { achievedTick: progress.achievedTick, epilogue: objective.epilogue } : {}),
    };
  });
}

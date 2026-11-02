import {
  npcCharacterProfileSchema,
  type AuthoredGameDraft,
  type NpcCharacterProfile,
  type StoryLoreEntry,
} from '@dreamwalk/contracts';

export type AuthoredCharacterSource = {
  id: string;
  characterProfile?: NpcCharacterProfile | null;
};

/** Only a new authored draft/version is enriched. Existing campaign snapshots are untouched. */
export function applyAuthoredCharacters(
  draft: AuthoredGameDraft,
  sources: AuthoredCharacterSource[],
  lorebook: StoryLoreEntry[] = [],
) {
  const entityId = (id: string) => draft.npcs.find((npc) => npc.sourceNpcId === id)?.id ?? id;
  for (const npc of draft.npcs) {
    const source = sources.find((entry) => entry.id === npc.sourceNpcId);
    if (!source) continue;
    if (npc.characterSource && npc.characterSource.npcId !== source.id)
      throw Error('CHARACTER_SOURCE_MISMATCH');
    if (source.characterProfile === null && npc.characterSource) {
      const baseline = structuredClone(npc.characterSource.baseline);
      npc.goal = baseline.goal;
      npc.personality = baseline.personality;
      npc.initialGoals = baseline.initialGoals;
      npc.promiseTemplates = baseline.promiseTemplates;
      delete npc.characterSource;
    }
    if (source.characterProfile) {
      const profile = remapCopiedCharacterProfile(
        npcCharacterProfileSchema.parse(source.characterProfile),
        new Map(
          draft.npcs.flatMap((entry) =>
            entry.sourceNpcId ? [[entry.sourceNpcId, entry.id] as const] : [],
          ),
        ),
      );
      if (!npc.characterSource)
        npc.characterSource = {
          version: 1,
          npcId: source.id,
          baseline: structuredClone({
            goal: npc.goal,
            ...(npc.personality ? { personality: npc.personality } : {}),
            ...(npc.initialGoals ? { initialGoals: npc.initialGoals } : {}),
            ...(npc.promiseTemplates ? { promiseTemplates: npc.promiseTemplates } : {}),
          }),
        };
      npc.goal = profile.initialGoal;
      npc.personality = {
        ...profile.personality,
        ...(profile.personality.links
          ? {
              links: profile.personality.links.map((link) => ({
                ...link,
                npcId: entityId(link.npcId),
              })),
            }
          : {}),
      };
      npc.initialGoals = profile.initialGoals
        ? structuredClone(profile.initialGoals).map((goal) => ({
            ...goal,
            ...(goal.targetId ? { targetId: entityId(goal.targetId) } : {}),
          }))
        : undefined;
      npc.promiseTemplates = profile.promiseTemplates
        ? structuredClone(profile.promiseTemplates)
        : undefined;
    }
    const authorFacts = lorebook
      .filter((entry) => entry.knowerNpcIds.includes(source.id))
      .map((entry) => ({
        id: `story-lore-${entry.id}`,
        title: entry.title,
        text: entry.text,
        disclosure: entry.disclosure,
        ...(entry.topicEntityId ? { topicEntityId: entityId(entry.topicEntityId) } : {}),
        ...(entry.publicQuestion ? { publicQuestion: entry.publicQuestion } : {}),
        ...(entry.topics?.length ? { relevanceTopics: [...entry.topics] } : {}),
        ...(entry.locationId
          ? {
              relevanceMapId:
                draft.maps.find((map) => map.sourceLocationId === entry.locationId)?.id ??
                entry.locationId,
            }
          : {}),
      }));
    // A story lore entry owns its ID. Preserve separately authored game facts, but never
    // grant another NPC knowledge just because the entry matches a search phrase.
    const otherFacts = (npc.initialFacts ?? []).filter(
      (fact) => !fact.id.startsWith('story-lore-'),
    );
    if (
      authorFacts.length ||
      lorebook.length ||
      otherFacts.length !== (npc.initialFacts ?? []).length
    )
      npc.initialFacts = [...otherFacts, ...authorFacts];
  }
  return draft;
}

/** Remap only typed entity-reference slots, never IDs of goals/items or authored prose. */
export function remapCopiedCharacterProfile(
  profile: NpcCharacterProfile,
  copies: ReadonlyMap<string, string>,
): NpcCharacterProfile {
  const copy = structuredClone(profile);
  const remap = (id: string) => copies.get(id) ?? id;
  for (const link of copy.personality.links ?? []) link.npcId = remap(link.npcId);
  const condition = (value: import('@dreamwalk/contracts').NpcCondition) => {
    if (value.kind === 'observed' && value.targetId) value.targetId = remap(value.targetId);
    if (value.kind === 'near_entity') value.entityId = remap(value.entityId);
  };
  for (const goal of copy.initialGoals ?? []) {
    if (goal.targetId) goal.targetId = remap(goal.targetId);
    [...goal.when, ...goal.success, ...goal.cancelWhen].forEach(condition);
  }
  for (const promise of copy.promiseTemplates ?? []) {
    if (promise.promisedAction)
      promise.promisedAction.targetId = remap(promise.promisedAction.targetId);
    promise.conditions.forEach(condition);
  }
  return copy;
}

export function remapCopiedStoryLore(
  lorebook: StoryLoreEntry[],
  copies: ReadonlyMap<string, string>,
): StoryLoreEntry[] {
  return structuredClone(lorebook).map((entry) => ({
    ...entry,
    knowerNpcIds: entry.knowerNpcIds.map((id) => copies.get(id) ?? id),
    ...(entry.topicEntityId
      ? { topicEntityId: copies.get(entry.topicEntityId) ?? entry.topicEntityId }
      : {}),
  }));
}

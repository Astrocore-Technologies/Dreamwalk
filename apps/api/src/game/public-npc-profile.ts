import type { GameState } from '@dreamwalk/contracts';

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Caller must verify the pinned package checksum. Restore only explicitly public
 * source fields, by stable identity, never the combined private memory biography.
 * Old hand-authored aliases without a stored identity mapping remain unchanged. */
export function restorePublicNpcPresentation(state: GameState, pinnedPackage: unknown) {
  const source = object(pinnedPackage);
  if (!source || !Array.isArray(source.npcDefinitions)) return state;
  let result = state;
  for (const value of source.npcDefinitions) {
    const definition = object(value),
      data = object(definition?.data);
    if (!definition || typeof definition.id !== 'string' || !data) continue;
    const entity = result.entities[definition.id];
    if (entity?.kind !== 'npc') continue;
    const additions: { personality?: string; greeting?: string } = {};
    if (entity.publicProfile?.personality === undefined && typeof data.personality === 'string')
      additions.personality = data.personality.slice(0, 4000);
    if (entity.publicProfile?.greeting === undefined && typeof data.greeting === 'string')
      additions.greeting = data.greeting.slice(0, 2000);
    if (!Object.keys(additions).length) continue;
    if (result === state) result = { ...state, entities: { ...state.entities } };
    result.entities[entity.id] = {
      ...entity,
      publicProfile: {
        role: '',
        description: '',
        appearance: '',
        ...entity.publicProfile,
        ...additions,
      },
    };
  }
  return result;
}

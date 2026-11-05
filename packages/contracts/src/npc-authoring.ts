import { z } from 'zod';
import {
  npcAuthoredFactSchema,
  npcGoalDefinitionSchema,
  npcPersonalitySchema,
  npcPromiseTemplateSchema,
} from './game/living';

/** Owner-authored, server-private behavior. Never use this as a public NPC DTO. */
export const npcCharacterProfileSchema = z
  .object({
    version: z.literal(1),
    personality: npcPersonalitySchema,
    initialGoal: z.enum(['patrol', 'help']),
    initialGoals: z.array(npcGoalDefinitionSchema).max(4).optional(),
    promiseTemplates: z.array(npcPromiseTemplateSchema).max(4).optional(),
  })
  .strict();
export type NpcCharacterProfile = z.infer<typeof npcCharacterProfileSchema>;

/** Knowing and disclosing are independent: public does not grant knowledge to everyone. */
export const storyLoreEntrySchema = npcAuthoredFactSchema
  .extend({
    id: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,53}$/)
      .refine((id) => !(id in Object.prototype)),
    knowerNpcIds: z
      .array(z.uuid())
      .min(1)
      .max(8)
      .refine((ids) => new Set(ids).size === ids.length, 'Duplicate knower'),
    locationId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,80}$/)
      .optional(),
    topics: z.array(z.string().trim().min(1).max(40)).max(6).optional(),
  })
  .strict();
export const storyLorebookSchema = z
  .array(storyLoreEntrySchema)
  .max(16)
  .refine(
    (entries) => new Set(entries.map((entry) => entry.id)).size === entries.length,
    'Duplicate lore ID',
  );
export type StoryLoreEntry = z.infer<typeof storyLoreEntrySchema>;

export function validateStoryLoreReferences(content: {
  npcIds: string[];
  locations: { id: string }[];
  lorebook?: StoryLoreEntry[];
  scenes?: { participantNpcIds?: string[] }[];
}) {
  return (
    (content.scenes ?? []).every((scene) =>
      (scene.participantNpcIds ?? []).every((id) => content.npcIds.includes(id)),
    ) &&
    (content.lorebook ?? []).every(
      (entry) =>
        entry.knowerNpcIds.every((id) => content.npcIds.includes(id)) &&
        (!entry.locationId ||
          content.locations.some((location) => location.id === entry.locationId)),
    )
  );
}

/** Strip all author-only records, including public-disclosure lore not yet learned in play. */
export function readerStoryContent<T extends Record<string, unknown>>(
  content: T,
): Omit<T, 'lorebook'> {
  const { lorebook: _lorebook, ...safe } = content;
  if (Array.isArray(safe.scenes))
    (safe as Record<string, unknown>).scenes = safe.scenes.map((scene: unknown) => {
      if (!scene || typeof scene !== 'object' || Array.isArray(scene)) return scene;
      const { participantNpcIds: _participants, ...publicScene } = scene as Record<string, unknown>;
      return publicScene;
    });
  return safe;
}

/** Relevance only, never an authorization grant or a reason to erase learned evidence. */
export function npcLoreRelevance(
  terms: readonly string[] | undefined,
  mapId: string | undefined,
  query: string,
  currentMapId: string | undefined,
): number {
  if (mapId && currentMapId && mapId !== currentMapId) return 0;
  const tokens = query.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!tokens.length) return 1;
  const searchable = (terms ?? []).join(' ').toLocaleLowerCase();
  return tokens.some((token) => searchable.includes(token)) ? 2 : 0;
}

/** Owner-only author preview; relevance is evaluated only AFTER the explicit knowledge gate. */
export function previewStoryLore(
  entries: StoryLoreEntry[],
  npcId: string,
  query = '',
  locationId?: string,
) {
  return entries.map((entry) => {
    if (!entry.knowerNpcIds.includes(npcId))
      return { id: entry.id, included: false, reason: 'not_known' as const };
    const relevant =
      npcLoreRelevance(
        [entry.title, entry.text, entry.publicQuestion ?? '', ...(entry.topics ?? [])],
        entry.locationId,
        query,
        locationId,
      ) > 0;
    return {
      id: entry.id,
      included: relevant,
      reason: relevant ? ('known_relevant' as const) : ('not_relevant' as const),
      ...(relevant ? { title: entry.title, text: entry.text, disclosure: entry.disclosure } : {}),
    };
  });
}

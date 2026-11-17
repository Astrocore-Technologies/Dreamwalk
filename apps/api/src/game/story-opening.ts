import { contentSchema } from '@dreamwalk/contracts';
import type { z } from 'zod';

export const OPENING_LOCATION_ID = 'opening';
export const OPENING_NAMES = {
  ru: 'Начало истории',
  uk: 'Початок історії',
  en: 'Story opening',
} as const;
export const clip = (text: string | undefined, max: number) => (text ?? '').slice(0, max);
export const openingLocationName = (language: string | undefined) =>
  OPENING_NAMES[(language as keyof typeof OPENING_NAMES) ?? 'ru'] ?? OPENING_NAMES.ru;
/** An author who wrote only a world and an opening message gets one opening scene; the AI plans the rest. */
export function withOpeningScene(
  content: z.infer<typeof contentSchema>,
  language: string | undefined,
): z.infer<typeof contentSchema> {
  if (content.locations.length || content.scenes.length) return content;
  const name = openingLocationName(language);
  return {
    ...content,
    locations: [{ id: OPENING_LOCATION_ID, name, description: '' }],
    scenes: [{ id: 'scene-opening', locationId: OPENING_LOCATION_ID, name, description: '' }],
    startSceneId: 'scene-opening',
  };
}

/** True when a story without author-made locations has no opening picture yet. */
export function openingArtMissing(source: {
  content?: { locations?: { id: string }[] };
  mapImages?: unknown[];
  omittedMapImages?: unknown[];
}): boolean {
  const locations = source.content?.locations ?? [];
  return (
    locations.length === 1 &&
    locations[0].id === OPENING_LOCATION_ID &&
    !source.mapImages?.length &&
    !source.omittedMapImages?.length
  );
}

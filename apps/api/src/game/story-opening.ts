import { contentSchema } from '@dreamwalk/contracts';
import type { z } from 'zod';

const OPENING_NAMES = { ru: 'Начало истории', uk: 'Початок історії', en: 'Story opening' } as const;
export const clip = (text: string | undefined, max: number) => (text ?? '').slice(0, max);
/** An author who wrote only a world and an opening message gets one opening scene; the AI plans the rest. */
export function withOpeningScene(
  content: z.infer<typeof contentSchema>,
  language: string | undefined,
): z.infer<typeof contentSchema> {
  if (content.locations.length || content.scenes.length) return content;
  const name = OPENING_NAMES[(language as keyof typeof OPENING_NAMES) ?? 'ru'] ?? OPENING_NAMES.ru;
  return {
    ...content,
    locations: [{ id: 'opening', name, description: '' }],
    scenes: [{ id: 'scene-opening', locationId: 'opening', name, description: '' }],
    startSceneId: 'scene-opening',
  };
}

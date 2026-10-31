import type { GameProjection } from '@dreamwalk/contracts';
type Locale = 'ru' | 'uk' | 'en';
type PublicLabel = { label?: string; labelTranslations?: Partial<Record<Locale, string>> };
function localizedLabel<T extends PublicLabel>(value: T, locale: Locale): T {
  const label = value.labelTranslations?.[locale];
  return label ? { ...value, label } : value;
}
/** Presentation only: curated public labels, never IDs, geometry, state or NPC speech. */
export function localizedProjection(
  projection: GameProjection | null,
  locale: Locale,
): GameProjection | null {
  if (!projection) return null;
  return {
    ...projection,
    map: {
      ...localizedLabel(projection.map, locale),
      exits: projection.map.exits.map((exit) => localizedLabel(exit, locale)),
    },
    entities: projection.entities.map((entity) => localizedLabel(entity, locale)),
    inventory: projection.inventory.map((entity) => localizedLabel(entity, locale)),
  };
}

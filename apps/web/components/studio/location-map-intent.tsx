'use client';
import type { MapIntent } from '@dreamwalk/contracts';
import { useT } from '@/lib/i18n';
/** Legacy props stay readable; new canvas geometry is not a user preference. */
export function LocationMapIntent(_props: {
  value?: MapIntent;
  onChange: (value?: MapIntent) => void;
}) {
  const { locale } = useT();
  const copy = {
    ru: 'Все новые карты — 24 × 24 клетки с обязательной сеткой. Маленькая локация занимает часть карты, остальное — её окружение: например, озеро в центре пещеры. Размер карты не меняет правила боя.',
    uk: 'Усі нові карти — 24 × 24 клітинки з обов’язковою сіткою. Маленька локація займає частину карти, решта — її оточення: наприклад, озеро в центрі печери. Розмір карти не змінює правила бою.',
    en: 'All new maps are 24 × 24 cells with a mandatory grid. A small location fills part of the map, with its surroundings around it: for example, a lake in the center of a cave. Map size does not change combat rules.',
  };
  return (
    <p className="muted" data-battlemap-policy="24x24">
      {copy[locale]}
    </p>
  );
}

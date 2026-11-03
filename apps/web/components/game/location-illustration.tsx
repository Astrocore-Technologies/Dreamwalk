'use client';
import Image from 'next/image';
import { useState } from 'react';
import type { GameAction, GamePoint, GameProjection } from '@dreamwalk/contracts';
import type { SceneIllustration } from '../assets/use-campaign-art';
import { artPreviewUrl } from '../assets/types';
import { useT } from '@/lib/i18n';
import { MapActions, InventoryPanel } from './map-actions';
import { useItemText } from './item-messages';
import styles from './game.module.css';

/** Illustration, not a coordinate map. Never draw speculative actor positions over the art. */
export function LocationIllustration({
  projection,
  illustration,
  disabled,
  onAction,
  onApproach,
  onInspectNpc,
  onSay,
}: {
  projection: GameProjection;
  illustration: SceneIllustration | null;
  disabled: boolean;
  onAction: (action: GameAction) => void;
  onApproach: (point: GamePoint) => void;
  onInspectNpc: (id: string) => void;
  onSay: (id: string) => void;
}) {
  const { locale } = useT();
  const itemText = useItemText();
  const [selected, setSelected] = useState<string | null>(null);
  const [inventory, setInventory] = useState(false);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const text = (ru: string, en: string, uk: string) =>
    locale === 'ru' ? ru : locale === 'uk' ? uk : en;
  const image =
    illustration?.mapId === projection.map.id &&
    illustration.slot === `map:${projection.map.id}:background` &&
    artPreviewUrl(illustration.url)
      ? illustration
      : null;
  return (
    <section className={styles.locationIllustration} data-location-illustration>
      <div className={styles.locationArtwork}>
        {image && failedUrl !== image.url ? (
          <Image
            unoptimized
            src={image.url}
            width={image.width}
            height={image.height}
            alt={projection.map.label || text('Локация', 'Location', 'Локація')}
            onError={() => setFailedUrl(image.url)}
          />
        ) : (
          <p role="status">
            {text(
              'Иллюстрация локации пока недоступна. Можно продолжать историю.',
              'The location illustration is not available yet. You can continue the story.',
              'Ілюстрація локації поки недоступна. Можна продовжувати історію.',
            )}
          </p>
        )}
      </div>
      <p className={styles.inspectionHelp}>
        {text(
          'Иллюстрация локации. Позиции персонажей с ней пока не сопоставлены; действия и общение доступны ниже.',
          'Location illustration. Character positions have not been matched to it; actions and conversation remain available below.',
          'Ілюстрація локації. Позиції персонажів із нею поки не зіставлено; дії та спілкування доступні нижче.',
        )}
      </p>
      {image && (
        <small>
          {image.attribution}
          {image.attribution && image.licenseLabel ? ' · ' : ''}
          {image.licenseLabel}
        </small>
      )}
      <div className={styles.inspectionButtons}>
        <strong>
          {projection.entities.find((e) => e.id === projection.actorId)?.label ||
            text('Ваш персонаж', 'Your character', 'Ваш персонаж')}
        </strong>
        {projection.entities
          .filter((e) => e.id !== projection.actorId)
          .map((e) => (
            <button type="button" key={e.id} disabled={disabled} onClick={() => setSelected(e.id)}>
              {e.label || e.id}
            </button>
          ))}
        {projection.map.exits.map((exit) => (
          <button
            type="button"
            key={exit.id}
            disabled={disabled}
            onClick={() => setSelected(`exit:${exit.id}`)}
          >
            {exit.label || exit.id}
          </button>
        ))}
        <button type="button" onClick={() => setInventory((v) => !v)} aria-expanded={inventory}>
          {itemText('inventory')} · {projection.inventory.length}
        </button>
      </div>
      {selected && (
        <MapActions
          projection={projection}
          ids={[selected]}
          position={{ x: 8, y: 8 }}
          disabled={disabled}
          onClose={() => setSelected(null)}
          onAction={onAction}
          onSay={onSay}
          onInspect={onInspectNpc}
          onApproach={onApproach}
        />
      )}
      {inventory && (
        <InventoryPanel
          projection={projection}
          disabled={disabled}
          onAction={onAction}
          onClose={() => setInventory(false)}
        />
      )}
    </section>
  );
}

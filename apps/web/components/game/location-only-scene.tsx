'use client';
import { useState } from 'react';
import type { GameAction, GameProjection } from '@dreamwalk/contracts';
import { canvasSceneArt } from '../assets/art-visibility';
import { artPreviewUrl } from '../assets/types';
import type { SceneIllustration, VisibleArtBinding } from '../assets/use-campaign-art';
import { InventoryPanel } from './map-actions';
import { useItemText } from './item-messages';
import { useTurnText } from './turn-messages';
import { npcUnavailable, publicLifeState } from './turn-ui';
import styles from './game.module.css';

/** The original location image is the map. Scene presence is not a token position. */
export function LocationOnlyScene({
  projection,
  art = [],
  illustration = null,
  onSelectNpc,
  onInspectNpc,
  onAction,
  disabled,
}: {
  projection: GameProjection;
  art?: VisibleArtBinding[];
  illustration?: SceneIllustration | null;
  onSelectNpc: (id: string) => void;
  onInspectNpc?: (id: string) => void;
  onAction?: (action: GameAction) => void;
  disabled: boolean;
}) {
  const text = useItemText();
  const turnText = useTurnText();
  const [inventoryOpen, setInventoryOpen] = useState(false);
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const background = canvasSceneArt(projection, art, illustration).find(
    (entry) => entry.slot === `map:${projection.map.id}:background`,
  );
  const imageUrl = background && artPreviewUrl(background.url);
  // The server projection is the visibility boundary. Never enumerate the map's
  // scenePresence manifest or recover participants from cached world state.
  const participants = projection.entities.filter(
    (entity) => entity.kind === 'npc' || entity.kind === 'player',
  );
  return (
    <section
      className={`${styles.mapSection} ${styles.locationScene}`}
      data-testid="location-only-scene"
      data-map-id={projection.map.id}
    >
      <figure className={styles.locationMap}>
        {imageUrl && failedImage !== imageUrl ? (
          <img
            key={imageUrl}
            src={imageUrl}
            alt={projection.map.label || text('locationMap')}
            onError={() => setFailedImage(imageUrl)}
            data-testid="location-map-image"
          />
        ) : (
          <p role="status">{text('unavailable')}</p>
        )}
        {(background?.attribution || background?.licenseLabel) && (
          <figcaption>
            {background.attribution}
            {background.attribution && background.licenseLabel ? ' · ' : ''}
            {background.licenseLabel}
          </figcaption>
        )}
      </figure>
      <div className={styles.locationParticipants}>
        <h3>{text('sceneParticipants')}</h3>
        <ul>
          {participants.map((entity) => {
            const life = publicLifeState(entity);
            return (
              <li key={entity.id} data-scene-participant={entity.id}>
                <strong>{entity.label || text('sceneParticipant')}</strong>
                {entity.publicProfile?.description && <p>{entity.publicProfile.description}</p>}
                {life !== 'conscious' && <p data-life-state={life}>{turnText(life)}</p>}
                {entity.kind === 'npc' && (
                  <div className={styles.menuActions}>
                    <button
                      type="button"
                      disabled={disabled || npcUnavailable(entity)}
                      onClick={() => onSelectNpc(entity.id)}
                    >
                      {text('say')}
                    </button>
                    {onInspectNpc && (
                      <button type="button" onClick={() => onInspectNpc(entity.id)}>
                        {text('inspect')}
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      <div className={styles.locationInventory}>
        <button
          type="button"
          aria-expanded={inventoryOpen}
          onClick={() => setInventoryOpen((open) => !open)}
        >
          {text('inventory')} · {projection.inventory.length}
        </button>
        {inventoryOpen && (
          <InventoryPanel
            projection={projection}
            disabled={disabled}
            onAction={(action) => onAction?.(action)}
            onClose={() => setInventoryOpen(false)}
          />
        )}
      </div>
    </section>
  );
}

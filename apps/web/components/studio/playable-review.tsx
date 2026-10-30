'use client';
import { useEffect, useState } from 'react';
import type { GameMap } from '@dreamwalk/contracts';
import { useResource } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Button, ErrorBox, Field, Loading, Select } from '@/components/ui';
import styles from './playable-map-editor.module.css';

type ReviewEntity = {
  id: string;
  kind: 'player' | 'npc' | 'item' | 'door';
  label?: string;
  visual?: string;
  mapId: string;
  x: number;
  y: number;
  locked?: boolean;
  open?: boolean;
  keyId?: string;
  ownerId?: string;
};
type ReviewResponse = {
  versionId: string | null;
  sourceRevision: number | null;
  compiled: null | {
    schemaVersion: number;
    rulesetVersion: string;
    title: string;
    startMapId: string;
    maps: Record<string, GameMap>;
    entities: Record<string, ReviewEntity>;
    roundPolicy: { maxRounds: number; planningMs: number };
    assetManifest: { id: string; sha256: string };
  };
};
/** GET-only view of the immutable, explicitly sanitized moderation projection. */
export function PlayableReview({
  adventureId,
  onReviewed,
}: {
  adventureId: string;
  onReviewed: (value: boolean, versionId: string | null) => void;
}) {
  const { t } = useT();
  const review = useResource<ReviewResponse>(`/admin/adventures/${adventureId}/playable-review`);
  const [mapId, setMapId] = useState(''),
    [checkedVersion, setCheckedVersion] = useState<string | null>(null);
  const checked = !!review.data?.versionId && review.data.versionId === checkedVersion;
  useEffect(() => {
    if (review.loading) setCheckedVersion(null);
  }, [review.loading]);
  useEffect(() => {
    onReviewed(
      !!review.data && !review.loading && !review.error && (!review.data.compiled || checked),
      review.data?.versionId || null,
    );
  }, [review.data, review.loading, review.error, checked, onReviewed]);
  if (review.loading) return <Loading />;
  if (review.error) return <ErrorBox message={review.error} retry={review.reload} />;
  if (!review.data?.compiled)
    return (
      <p className="muted">
        {t('В этой заявке нет игровой карты: проверяется литературная история.')}
      </p>
    );
  const source = review.data.compiled,
    maps = Object.values(source.maps);
  const map = source.maps[mapId] || maps[0];
  if (!map)
    return (
      <ErrorBox
        message={t(
          'Карта не прошла проверку. Проверь стены, точки появления, выходы и доступность ключей.',
        )}
      />
    );
  const entities = Object.values(source.entities).filter((entity) => entity.mapId === map.id);
  const name = (entity: ReviewEntity) =>
    entity.label || t(entity.kind === 'npc' ? 'NPC' : entity.kind === 'door' ? 'Дверь' : 'Предмет');
  return (
    <section className={styles.editor} aria-label={t('Игровая карта на модерации')}>
      <h3>{t('Игровая карта на модерации')}</h3>
      <Button
        type="button"
        variant="ghost"
        onClick={() => {
          setCheckedVersion(null);
          review.reload();
        }}
      >
        {t('Обновить проверяемую версию')}
      </Button>
      <p>{t('Это неизменяемая отправленная версия, а не текущий черновик автора.')}</p>
      <h4>{source.title}</h4>
      <p>
        {t('Игровая версия {version}', { version: review.data.sourceRevision || 0 })} ·{' '}
        <code>{review.data.versionId}</code>
      </p>
      <Field label={t('Карта для проверки')}>
        <Select value={map.id} onChange={(event) => setMapId(event.target.value)}>
          {maps.map((value) => (
            <option key={value.id} value={value.id}>
              {value.label || value.id}
            </option>
          ))}
        </Select>
      </Field>
      <p>
        {t('Стартовая карта')}: {source.maps[source.startMapId]?.label || source.startMapId}
      </p>
      <div className={styles.gridScroll}>
        <div
          className={styles.grid}
          style={{ gridTemplateColumns: `repeat(${map.width}, 30px)` }}
          role="group"
          aria-label={t('Раскладка карты')}
        >
          {Array.from({ length: map.width * map.height }, (_, index) => {
            const x = index % map.width,
              y = Math.floor(index / map.width),
              blocked = map.blocked.some((point) => point.x === x && point.y === y),
              entity = entities.find((value) => !value.ownerId && value.x === x && value.y === y),
              exit = map.exits.find((value) => value.x === x && value.y === y),
              spawn = map.spawns.some((point) => point.x === x && point.y === y);
            const label = entity
              ? name(entity)
              : t(exit ? 'Переход' : spawn ? 'Точка появления' : blocked ? 'Стена' : 'Пол');
            return (
              <span
                key={index}
                className={blocked ? styles.wall : styles.tile}
                title={t('Клетка {x}, {y}: {object}', { x, y, object: label })}
                aria-hidden="true"
                style={{ display: 'grid', placeItems: 'center', width: 30, height: 30 }}
              >
                {entity?.kind === 'npc'
                  ? '♟'
                  : entity?.kind === 'door'
                    ? '▣'
                    : entity
                      ? '◇'
                      : exit
                        ? '↗'
                        : spawn
                          ? '◎'
                          : blocked
                            ? '■'
                            : '·'}
              </span>
            );
          })}
        </div>
      </div>
      <details>
        <summary>{t('Стены и непроходимые клетки')}</summary>
        <p>{map.blocked.map((point) => `${point.x}, ${point.y}`).join(' · ') || t('Не указаны')}</p>
      </details>
      <ul>
        {map.spawns.map((point, index) => (
          <li key={index}>
            {t('Точка появления')} · {t('Координаты: {x}, {y}', point)}
          </li>
        ))}
        {map.exits.map((exit) => (
          <li key={exit.id}>
            {t('Переход')} · {t('Координаты: {x}, {y}', { x: exit.x, y: exit.y })} →{' '}
            {source.maps[exit.destinationMapId]?.label || exit.destinationMapId} (
            {exit.destination.x}, {exit.destination.y})
            {exit.doorId ? ` · ${source.entities[exit.doorId]?.label || exit.doorId}` : ''}
          </li>
        ))}
      </ul>
      <ul>
        {entities.map((entity) => (
          <li key={entity.id}>
            <strong>{name(entity)}</strong> ·{' '}
            {t('Координаты: {x}, {y}', { x: entity.x, y: entity.y })}
            {entity.kind === 'door'
              ? ` · ${t(entity.locked ? 'Заперто' : entity.open ? 'Открыто' : 'Закрыто')}`
              : ''}
            {entity.keyId
              ? ` · ${t('Ключ от двери')}: ${source.entities[entity.keyId]?.label || entity.keyId}`
              : ''}
            {entity.ownerId
              ? ` · ${t('Владелец предмета')}: ${source.entities[entity.ownerId]?.label || entity.ownerId}`
              : ''}
          </li>
        ))}
      </ul>
      <p>
        {t('Раундов в столкновении')}: {source.roundPolicy.maxRounds} ·{' '}
        {t('Секунд на планирование')}: {source.roundPolicy.planningMs / 1000}
      </p>
      <details>
        <summary>{t('Закреплённый графический набор')}</summary>
        <code>{source.assetManifest.id}</code>
        <p>
          <code>{source.assetManifest.sha256}</code>
        </p>
      </details>
      <label>
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) =>
            setCheckedVersion(event.target.checked ? review.data!.versionId : null)
          }
        />{' '}
        {t('Я проверил игровые карты, объекты и переходы этой версии.')}
      </label>
    </section>
  );
}

'use client';
import { ObjectiveReview } from './objective-review';
import { PinnedArtReview } from '../assets/pinned-art-review';
import { useEffect, useState } from 'react';
import type {
  GameMap,
  ObjectiveDefinition,
  NpcPersonality,
  NpcObservation,
  NpcGoalDefinition,
  NpcPromiseTemplate,
} from '@dreamwalk/contracts';
import { useResource } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Button, ErrorBox, Field, Loading, Select } from '@/components/ui';
import { LivingDefinitionReview } from './living-definition-review';
import { ModeratorNpcPreview } from './moderator-npc-preview';
import { publicStyleLabels } from './living-npc-profile';
import { habitLabels, relationLabels } from './living-npc-examples';
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
    objectives?: ObjectiveDefinition[];
    artBindings?: { slot: string; revisionId: string }[];
    npcPolicy?: 'reactive-v1' | null;
    npcProfiles?: {
      npcId: string;
      personality: NpcPersonality | null;
      initialGoal: string;
      initialFacts?: NpcObservation[];
      initialGoals?: NpcGoalDefinition[];
      promiseTemplates?: NpcPromiseTemplate[];
      initialKnowledge?: { id: string; targetId?: string; revealCondition?: string }[];
      patrolTarget: { x: number; y: number };
    }[];
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
  const [artReady, setArtReady] = useState(false);
  const needsArt = !!review.data?.compiled?.artBindings?.length;
  const [mapId, setMapId] = useState(''),
    [checkedVersion, setCheckedVersion] = useState<string | null>(null);
  const checked = !!review.data?.versionId && review.data.versionId === checkedVersion;
  useEffect(() => {
    if (review.loading) setCheckedVersion(null);
  }, [review.loading]);
  useEffect(() => {
    onReviewed(
      !!review.data &&
        !review.loading &&
        !review.error &&
        (!review.data.compiled || (checked && (!needsArt || artReady))),
      review.data?.versionId || null,
    );
  }, [review.data, review.loading, review.error, checked, onReviewed, needsArt, artReady]);
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
      <ObjectiveReview
        objectives={source.objectives}
        name={(id) => source.entities[id]?.label || source.maps[id]?.label || id}
      />
      {source.npcPolicy === 'reactive-v1' && (
        <section aria-label={t('Поведение NPC на модерации')}>
          <h4>{t('Поведение NPC на модерации')}</h4>
          <p>
            {t(
              'Проверяются авторские определения этой версии, не личная память участников кампании.',
            )}
          </p>
          {source.npcProfiles?.map((profile) => (
            <article key={profile.npcId}>
              <h4>{source.entities[profile.npcId]?.label || t('NPC')}</h4>
              <p>
                {t('Начальные знания')}:{' '}
                {profile.initialKnowledge
                  ?.map(
                    (knowledge) => source.entities[knowledge.targetId || '']?.label || t('Предмет'),
                  )
                  .join(', ') || t('Не указаны')}
              </p>
              {profile.personality && (
                <>
                  <p>
                    {t('Роль NPC')}:{' '}
                    {t(
                      profile.personality.role === 'guard'
                        ? 'Смотритель'
                        : profile.personality.role === 'helper'
                          ? 'Помощник'
                          : 'Патруль',
                    )}
                  </p>
                  <p>
                    {t('Привычки')}:{' '}
                    {profile.personality.habits?.map((habit) => t(habitLabels[habit])).join(', ') ||
                      t('Не указаны')}
                  </p>
                  <ul>
                    {profile.personality.decisionExamples?.map((example, index) => (
                      <li key={index}>
                        {example.situation} — {example.response}
                      </li>
                    ))}
                  </ul>
                  <ul>
                    {profile.personality.links?.map((link) => (
                      <li key={link.npcId}>
                        {source.entities[link.npcId]?.label || t('NPC')} ·{' '}
                        {t(relationLabels[link.relation])}
                      </li>
                    ))}
                  </ul>
                  <p>
                    {t('Профиль поведения')}:{' '}
                    {profile.personality.behaviorProfile === 'cookie' ? 'Cookie' : 'Green Apple'}
                  </p>
                  {profile.personality.biography && <p>{profile.personality.biography}</p>}
                  <p>
                    {t('Публичная манера речи')}:{' '}
                    {t(publicStyleLabels[profile.personality.publicSpeechStyle || 'neutral'])}
                  </p>
                  {profile.personality.speechStyle && (
                    <p>
                      {t('Частные заметки о манере речи')}: {profile.personality.speechStyle}
                    </p>
                  )}
                  <p>
                    {t('Ценности')}:{' '}
                    {profile.personality.values
                      .map((value) =>
                        t(
                          {
                            duty: 'Долг',
                            kindness: 'Доброта',
                            caution: 'Осторожность',
                            honesty: 'Честность',
                          }[value],
                        ),
                      )
                      .join(', ')}
                  </p>
                  <p>
                    {t('Границы поведения')}:{' '}
                    {profile.personality.taboos
                      .map((value) =>
                        t(
                          {
                            steal: 'Не красть',
                            harm: 'Не причинять вред',
                            disclose_private: 'Не разглашать тайны',
                            share_rumors: 'Не распространять слухи',
                            give_valuables: 'Не отдавать ценности',
                            lock_doors: 'Не запирать двери',
                          }[value],
                        ),
                      )
                      .join(', ')}
                  </p>
                </>
              )}
              <LivingDefinitionReview
                facts={profile.initialFacts || []}
                goals={profile.initialGoals || []}
                promises={profile.promiseTemplates || []}
                names={source.entities}
              />
              {review.data?.versionId && (
                <ModeratorNpcPreview
                  adventureId={adventureId}
                  versionId={review.data.versionId}
                  npcId={profile.npcId}
                />
              )}
            </article>
          ))}
        </section>
      )}
      <p>
        {t('Игровая версия {version}', { version: review.data.sourceRevision || 0 })} ·{' '}
        <code>{review.data.versionId}</code>
      </p>
      <Field label={t('Карта для проверки')}>
        <Select
          aria-label={t('Карта для проверки')}
          value={map.id}
          onChange={(event) => setMapId(event.target.value)}
        >
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
      {needsArt && review.data.versionId && (
        <PinnedArtReview
          key={review.data.versionId}
          versionId={review.data.versionId}
          onReady={setArtReady}
        />
      )}
      <label>
        <input
          disabled={needsArt && !artReady}
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

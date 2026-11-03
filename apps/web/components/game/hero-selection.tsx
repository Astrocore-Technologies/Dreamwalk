'use client';
import { useId, useRef, useState } from 'react';
import { BookOpen, Check, Plus, Sparkles, UserRound } from 'lucide-react';
import styles from './hero-choice.module.css';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import type { Hero, CampaignHeroResponse } from '@dreamwalk/contracts';
import { assetUrl, useClient, useResource } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Button, ErrorBox, Field, Modal, Select } from '@/components/ui';
const rows = {
  solo: ['Соло', 'Solo', 'Соло'],
  friends: ['С друзьями', 'With friends', 'З друзями'],
  soloFriends: ['Соло / с друзьями', 'Solo / with friends', 'Соло / з друзями'],
  expand: ['Выбрать героя', 'Choose a hero', 'Обрати героя'],
  done: ['Герой выбран', 'Done choosing hero', 'Героя обрано'],
  close: ['Закрыть выбор', 'Close hero selection', 'Закрити вибір'],
  empty: [
    'У тебя пока нет сохранённых героев.',
    'You have no saved heroes yet.',
    'У тебе ще немає збережених героїв.',
  ],
  loading: ['Загружаем героев…', 'Loading heroes…', 'Завантажуємо героїв…'],
  create: ['Подготовить героя', 'Prepare a hero', 'Підготувати героя'],
  createHint: [
    'Создай героя в разделе «Мои герои», затем вернись в историю.',
    'Create a hero in My heroes, then return to this story.',
    'Створи героя в розділі «Мої герої», потім повернися до історії.',
  ],
  selectOnly: [
    'Выбор героя не запускает игру. Ведущий и запуск — на странице истории.',
    'Choosing a hero does not start the game. Director and start controls are on the story page.',
    'Вибір героя не запускає гру. Ведучий і запуск — на сторінці історії.',
  ],
  choose: ['Герой для этого прохождения', 'Hero for this campaign', 'Герой для цього проходження'],
  traveler: [
    'Путешественник без сохранённого героя',
    'Traveler without a saved hero',
    'Мандрівник без збереженого героя',
  ],
  pinned: [
    'Образ героя закрепится при входе: последующие правки не изменят это прохождение. Имя и портрет видны участникам с доступом, когда герой находится в их поле зрения. Предыстория, черты и заметки видны только тебе.',
    'Your hero is pinned when you join; later edits do not change this campaign. Name and portrait are shared with authorized participants who can see the hero. Backstory, traits and notes are visible only to you.',
    'Образ героя закріпиться при вході: подальші правки не змінять це проходження. Ім’я та портрет видимі учасникам із доступом, коли герой у їхньому полі зору. Передісторія, риси та нотатки видимі лише тобі.',
  ],
  missing: [
    'Выбранный герой недоступен. Выбери другого героя или путешественника.',
    'The selected hero is unavailable. Choose another hero or the traveler.',
    'Вибраний герой недоступний. Обери іншого героя або мандрівника.',
  ],
  adventures: ['Выбрать приключение', 'Choose an adventure', 'Обрати пригоду'],
  manage: ['Мои герои', 'My heroes', 'Мої герої'],
  play: ['Играть этим героем', 'Play as this hero', 'Грати цим героєм'],
  saved: [
    'Твой герой в этом сохранении',
    'Your hero in this save',
    'Твій герой в цьому збереженні',
  ],
  private: [
    'Личная история и заметки — только тебе',
    'Personal story and notes — only you',
    'Особиста історія та нотатки — лише тобі',
  ],
} as const;
export function useHeroText() {
  const { locale } = useT();
  return (key: keyof typeof rows) => rows[key][locale === 'ru' ? 0 : locale === 'en' ? 1 : 2];
}
export function useHeroSelection() {
  const { user } = useClient();
  const params = useSearchParams();
  const requested = params.get('heroId') || '';
  const [choice, setChoice] = useState<{ requested: string; id: string } | null>(null);
  const heroId = choice?.requested === requested ? choice.id : requested;
  const resource = useResource<Hero[]>(user ? '/heroes' : null);
  const valid = !heroId || !!resource.data?.some((hero) => hero.id === heroId);
  return {
    heroId,
    setHeroId: (id: string) => setChoice({ requested, id }),
    resource,
    ready: !user || !heroId || (!resource.loading && !resource.error && valid),
    valid,
    body: heroId ? { heroId } : {},
    enabled: !!user,
  };
}
export function HeroSelection({
  selection,
  disabled = false,
  compact = false,
  presentation,
}: {
  selection: ReturnType<typeof useHeroSelection>;
  disabled?: boolean;
  compact?: boolean;
  presentation?: {
    title: string;
    synopsis: string;
    genre: string;
    playersMin: number;
    playersMax: number;
    cover: string;
    manageHref: string;
  };
}) {
  const h = useHeroText();
  const [expanded, setExpanded] = useState(false);
  const radioName = useId();
  const root = useRef<HTMLDivElement>(null);
  function closePicker() {
    setExpanded(false);
    requestAnimationFrame(() => {
      const trigger = root.current?.querySelector<HTMLButtonElement>('[data-hero-choice-trigger]');
      (trigger && !trigger.disabled ? trigger : root.current)?.focus();
    });
  }
  const blocked = disabled || selection.resource.loading;
  if (!selection.enabled) return null;
  return (
    <div
      ref={root}
      tabIndex={compact ? -1 : undefined}
      role={compact ? 'group' : undefined}
      aria-label={compact ? h('choose') : undefined}
      className="stack"
      data-testid="hero-selection"
      style={{ minWidth: 0, maxWidth: '100%' }}
    >
      <Field label={h('choose')} hint={compact ? undefined : h('pinned')}>
        <Select
          value={selection.heroId}
          disabled={disabled || selection.resource.loading}
          onChange={(event) => selection.setHeroId(event.target.value)}
        >
          <option value="">{h('traveler')}</option>
          {selection.heroId && !selection.valid && (
            <option value={selection.heroId}>{h('missing')}</option>
          )}
          {selection.resource.data?.map((hero) => (
            <option key={hero.id} value={hero.id}>
              {hero.name}
            </option>
          ))}
        </Select>
      </Field>
      <ErrorBox
        message={
          selection.resource.error ||
          (!selection.resource.loading && !selection.valid ? h('missing') : '')
        }
        retry={selection.resource.reload}
      />
      {compact && (
        <>
          <Button
            type="button"
            variant="secondary"
            disabled={disabled}
            onClick={() => setExpanded(true)}
            data-hero-choice-trigger
            aria-haspopup="dialog"
          >
            {h('expand')}
          </Button>
          {expanded && (
            <Modal title={h('expand')} className={styles.dialog} onClose={closePicker}>
              <div className={styles.scene}>
                {presentation && (
                  <img className={styles.backdrop} src={presentation.cover} alt="" />
                )}
                <p className={styles.storyTitle}>{presentation?.title}</p>
                <p>{h('selectOnly')}</p>
                {selection.resource.loading && <p role="status">{h('loading')}</p>}
                {!selection.resource.loading &&
                  !selection.resource.error &&
                  selection.resource.data?.length === 0 && <p>{h('empty')}</p>}
                <ErrorBox
                  message={
                    selection.resource.error ||
                    (!selection.resource.loading && !selection.valid ? h('missing') : '')
                  }
                  retry={selection.resource.reload}
                />
                <fieldset className={styles.choices} disabled={blocked}>
                  <legend className={styles.legend}>{h('choose')}</legend>
                  {selection.resource.data?.map((hero) => (
                    <label className={styles.card} key={hero.id}>
                      <input
                        type="radio"
                        name={radioName}
                        value={hero.id}
                        checked={selection.heroId === hero.id}
                        onChange={() => selection.setHeroId(hero.id)}
                      />
                      <HeroChoicePortrait
                        key={hero.portraitAssetId || 'none'}
                        assetId={hero.portraitAssetId}
                      />
                      <span className={styles.cardBody}>
                        <strong>{hero.name}</strong>
                        <span>{hero.traits.join(' · ')}</span>
                      </span>
                      {selection.heroId === hero.id && (
                        <Check className={styles.check} aria-hidden="true" />
                      )}
                    </label>
                  ))}
                  <label className={`${styles.card} ${styles.traveler}`}>
                    <input
                      type="radio"
                      name={radioName}
                      value=""
                      checked={selection.heroId === ''}
                      onChange={() => selection.setHeroId('')}
                    />
                    <span className={styles.portrait}>
                      <UserRound aria-hidden="true" />
                    </span>
                    <span className={styles.cardBody}>
                      <strong>{h('traveler')}</strong>
                    </span>
                    {selection.heroId === '' && (
                      <Check className={styles.check} aria-hidden="true" />
                    )}
                  </label>
                  {presentation &&
                    (blocked ? (
                      <span className={`${styles.card} ${styles.create}`} aria-disabled="true">
                        <HeroCreateArtwork />
                        <strong>{h('create')}</strong>
                        <span>{h('createHint')}</span>
                      </span>
                    ) : (
                      <Link
                        className={`${styles.card} ${styles.create}`}
                        href={presentation.manageHref}
                      >
                        <HeroCreateArtwork />
                        <strong>{h('create')}</strong>
                        <span>{h('createHint')}</span>
                      </Link>
                    ))}
                </fieldset>
                <small>{h('pinned')}</small>
                {presentation && (
                  <div className={styles.summary}>
                    <img src={presentation.cover} alt="" />
                    <div className={styles.summaryText}>
                      <strong>{presentation.title}</strong>
                      <p className={styles.metadata}>
                        <BookOpen size={22} aria-hidden="true" />
                        <span>{presentation.genre}</span>
                        {presentation.playersMin >= 1 &&
                          presentation.playersMax >= presentation.playersMin && (
                            <span>
                              ·{' '}
                              {h(
                                presentation.playersMax === 1
                                  ? 'solo'
                                  : presentation.playersMin === 1
                                    ? 'soloFriends'
                                    : 'friends',
                              )}{' '}
                              (
                              {presentation.playersMin === presentation.playersMax
                                ? presentation.playersMin
                                : `${presentation.playersMin}–${presentation.playersMax}`}
                              )
                            </span>
                          )}
                      </p>
                      {presentation.synopsis && <p>{presentation.synopsis}</p>}
                    </div>
                  </div>
                )}
                <div className={styles.actions}>
                  <Button type="button" variant="secondary" onClick={closePicker}>
                    {h('close')}
                  </Button>
                  <Button
                    type="button"
                    disabled={blocked || !selection.valid}
                    onClick={closePicker}
                  >
                    {h('done')}
                  </Button>
                </div>
              </div>
            </Modal>
          )}
        </>
      )}
      {!compact && <Link href="/my-characters">{h('manage')}</Link>}
    </div>
  );
}
export function CampaignHero({ campaignId }: { campaignId: string }) {
  const h = useHeroText();
  const snapshot = useResource<CampaignHeroResponse>(`/game/campaigns/${campaignId}/hero`);
  const hero = snapshot.data?.hero;
  return (
    <section data-testid="campaign-hero" className="stack" style={{ overflowWrap: 'anywhere' }}>
      <strong>{h('saved')}</strong>
      <ErrorBox message={snapshot.error} retry={snapshot.reload} />
      {hero ? (
        <>
          <h2>{hero.name}</h2>
          {hero.portraitUrl && (
            <img
              src={hero.portraitUrl}
              alt={hero.name}
              width={64}
              height={80}
              loading="lazy"
              decoding="async"
              style={{ objectFit: 'cover' }}
            />
          )}
          <details>
            <summary>{h('private')}</summary>
            <p>{hero.backstory}</p>
            <p>{hero.traits.join(', ')}</p>
            <p>{hero.notes}</p>
            <small>{h('pinned')}</small>
          </details>
        </>
      ) : !snapshot.loading && !snapshot.error ? (
        <p>{h('traveler')}</p>
      ) : null}
    </section>
  );
}

function HeroChoicePortrait({ assetId }: { assetId: string | null }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={styles.portrait}>
      {assetId && !failed ? (
        <img src={assetUrl(assetId)} alt="" onError={() => setFailed(true)} />
      ) : (
        <UserRound aria-hidden="true" />
      )}
    </span>
  );
}

function HeroCreateArtwork() {
  return (
    <span className={styles.createArt} aria-hidden="true">
      <UserRound className={styles.createSilhouette} />
      <Sparkles className={styles.createSpark} />
      <Plus className={styles.createPlus} />
    </span>
  );
}

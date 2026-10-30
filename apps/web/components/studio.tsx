'use client';
import { AutosaveStatus } from './studio/autosave-status';
import { useDraftAutosave } from '@/lib/use-draft-autosave';
import { PlayableMapEditor } from './studio/playable-map-editor';
import { useT } from '@/lib/i18n';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  Copy,
  Eye,
  Feather,
  ImagePlus,
  MapPin,
  Plus,
  Save,
  Send,
  ShieldCheck,
  Trash2,
  Users,
} from 'lucide-react';
import {
  adventureSchema,
  npcSchema,
  selectAdventureText,
  selectNpcText,
  findControlledTag,
  type ControlledTag,
  type Adventure,
  type Asset,
  type Invitation,
  type ModelProfile,
  type Npc,
} from '@dreamwalk/contracts';
import {
  api,
  assetUrl,
  coverUrl,
  useDate,
  errorMessage,
  useClient,
  useResource,
} from '@/lib/client';
import {
  Badge,
  Button,
  ButtonLink,
  Empty,
  ErrorBox,
  Field,
  Input,
  Loading,
  Modal,
  PageHeading,
  Panel,
  Select,
  Tabs,
  Textarea,
  UploadField,
} from './ui';
import styles from './studio/studio.module.css';

const statuses: Record<string, string> = {
  draft: 'Черновик',
  pending_review: 'На проверке',
  published: 'Опубликовано',
  archived: 'В архиве',
};
const steps = [
  'Основное',
  'Мир и правила',
  'Локации',
  'NPC',
  'Стартовая сцена',
  'Ограничения',
  'Просмотр',
  'Публикация',
];
const newContent = {
  world: '',
  rules: '',
  locations: [],
  npcIds: [],
  scenes: [],
  startSceneId: '',
  boundaries: [],
};
type AdventureDraft = Pick<
  Adventure,
  | 'title'
  | 'sourceLanguage'
  | 'visibility'
  | 'synopsis'
  | 'genre'
  | 'tags'
  | 'cover'
  | 'coverAssetId'
  | 'playersMin'
  | 'playersMax'
  | 'duration'
  | 'difficulty'
  | 'content'
>;
const blankDraft: AdventureDraft = {
  sourceLanguage: 'ru',
  visibility: 'private',
  title: '',
  synopsis: '',
  genre: 'Тайна',
  tags: [],
  cover: 'observatory',
  coverAssetId: null,
  playersMin: 1,
  playersMax: 4,
  duration: '1–2 часа',
  difficulty: 'Средне',
  content: newContent,
};
function toDraft(a: Adventure): AdventureDraft {
  return {
    title: a.title,
    sourceLanguage: a.sourceLanguage || 'ru',
    visibility: a.visibility || 'private',
    synopsis: a.synopsis,
    genre: a.genre,
    tags: a.tags,
    cover: a.cover,
    coverAssetId: a.coverAssetId,
    playersMin: a.playersMin,
    playersMax: a.playersMax,
    duration: a.duration,
    difficulty: a.difficulty,
    content: a.content,
  };
}
function useDirtyWarning(dirty: boolean) {
  const { t } = useT();
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    const navigate = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (
        !(link instanceof HTMLAnchorElement) ||
        link.target === '_blank' ||
        link.hasAttribute('download')
      )
        return;
      const next = new URL(link.href, location.href);
      if (next.pathname === location.pathname && next.search === location.search) return;
      if (!window.confirm(t('Есть несохранённые изменения. Покинуть редактор?'))) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener('beforeunload', handler);
    document.addEventListener('click', navigate, true);
    return () => {
      window.removeEventListener('beforeunload', handler);
      document.removeEventListener('click', navigate, true);
    };
  }, [dirty]);
}
export function StudioPage({ path }: { path: string }) {
  if (path.startsWith('/studio/npcs/')) return <NpcEditor key={path} id={path.split('/')[3]} />;
  if (path === '/studio/npcs') return <NpcLibrary />;
  if (path.startsWith('/studio/adventures/'))
    return <AdventureEditor key={path} id={path.split('/')[3]} />;
  return <StudioHome />;
}
function StudioTabs({ npcs = false }: { npcs?: boolean }) {
  const { t } = useT();
  return (
    <Tabs
      items={[
        { href: '/studio', label: t('Приключения'), active: !npcs },
        { href: '/studio/npcs', label: t('Библиотека NPC'), active: npcs },
      ]}
    />
  );
}
function StudioHome() {
  const date = useDate();
  const { t, taxonomy, locale } = useT();
  const items = useResource<Adventure[]>('/studio/adventures');
  return (
    <>
      <PageHeading
        eyebrow={t('ТВОРЧЕСКАЯ МАСТЕРСКАЯ')}
        title={t('Здесь начинаются миры')}
        description={t(
          'Превратите идею в место, куда захочется вернуться. Всё начинается с первого черновика.',
        )}
        action={
          <ButtonLink href="/studio/adventures/new">
            <Plus size={17} />
            {t('Создать приключение')}
          </ButtonLink>
        }
      />
      <StudioTabs />
      <div className={styles.studioIntro}>
        <div className={styles.introIcon}>
          <Feather size={32} />
        </div>
        <div>
          <h2>{t('Ваша история. Ваши правила.')}</h2>
          <p>
            {t(
              'Соберите мир, локации и персонажей. Сохраните личный черновик или отправьте его на проверку для каталога.',
            )}
          </p>
        </div>
        <Badge>{t('Ручные инструменты')}</Badge>
      </div>
      <ErrorBox message={items.error} retry={items.reload} />
      {items.loading ? (
        <Loading />
      ) : items.data?.length ? (
        <div className={styles.adventureList}>
          {items.data.map((a) => (
            <Link href={`/studio/adventures/${a.id}`} key={a.id} className={styles.storyRow}>
              <img src={coverUrl(a)} alt="" />
              <div>
                <Badge tone={a.status === 'published' ? 'green' : ''}>
                  {t(statuses[a.status])}
                </Badge>
                <h2>{selectAdventureText(a, locale).title}</h2>
                <p>
                  {selectAdventureText(a, locale).synopsis || t('У этой истории ещё всё впереди.')}
                </p>
                <small>
                  {taxonomy(a.genre)} {t(' · Версия ')}
                  {a.version || '—'} {t(' · Изменено ')}
                  {date(a.updatedAt)}
                </small>
              </div>
              <ArrowRight size={22} />
            </Link>
          ))}
        </div>
      ) : (
        !items.error && (
          <Empty
            title={t('Чистая страница — тоже начало')}
            description={t(
              'Создайте первое приключение. Оно останется вашим личным черновиком, пока вы не решите поделиться.',
            )}
            action={
              <ButtonLink href="/studio/adventures/new">
                <Plus size={16} />
                {t('Начать историю')}
              </ButtonLink>
            }
          />
        )
      )}
      <div className="notice">
        <ShieldCheck size={18} />
        {t(
          'Публичные истории проходят проверку. Игровые сессии и AI-генерация появятся на следующем этапе.',
        )}
      </div>
    </>
  );
}

function MediaPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const assets = useResource<Asset[]>(open ? '/assets' : null);
  return (
    <div className="stack">
      <div className="row">
        <UploadField
          label={t('Загрузить обложку')}
          onUploaded={(a) => {
            onChange(a.id);
            assets.reload();
          }}
        />
        <Button variant="ghost" type="button" onClick={() => setOpen(true)}>
          <ImagePlus size={16} />
          {t('Моя медиатека')}
        </Button>
        {value && (
          <Button variant="ghost" type="button" onClick={() => onChange(null)}>
            {t('Убрать')}
          </Button>
        )}
      </div>
      {value && (
        <img
          className={styles.assetPreview}
          src={assetUrl(value)}
          alt={t('Выбранное изображение')}
        />
      )}
      {open && (
        <Modal title={t('Моя медиатека')} onClose={() => setOpen(false)}>
          <p className="muted">
            {t('Загруженные вами растровые изображения. Выберите одно для этой истории.')}
          </p>
          <ErrorBox message={assets.error} retry={assets.reload} />
          {assets.loading ? (
            <Loading />
          ) : assets.data?.length ? (
            <div className={styles.mediaGrid}>
              {assets.data.map((a) => (
                <button
                  type="button"
                  key={a.id}
                  className={styles.mediaTile}
                  onClick={() => {
                    onChange(a.id);
                    setOpen(false);
                  }}
                  aria-label={t('Выбрать изображение {width} на {height}', {
                    width: a.width,
                    height: a.height,
                  })}
                >
                  <img src={a.url || assetUrl(a.id)} alt="" />
                  <span>
                    {a.width} × {a.height}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p>{t('Пока нет изображений. Загрузите PNG, JPEG или WebP.')}</p>
          )}
          <Button variant="secondary" type="button" onClick={() => setOpen(false)}>
            {t('Отмена')}
          </Button>
        </Modal>
      )}
    </div>
  );
}

function AdventureEditor({ id }: { id: string }) {
  const date = useDate();
  const { t, taxonomy, locale } = useT();
  const router = useRouter(),
    { toast, user } = useClient(),
    isNew = id === 'new';
  const resource = useResource<Adventure>(isNew ? null : `/studio/adventures/${id}`),
    npcs = useResource<Npc[]>('/npcs'),
    genres = useResource<string[]>('/genres'),
    tagDefinitions = useResource<ControlledTag[]>('/tags');
  const [draft, setDraft] = useState<AdventureDraft>(() => ({
      ...blankDraft,
      sourceLanguage: locale,
      duration: t('1–2 часа'),
      visibility: user?.settings.defaultVisibility === 'public' ? 'public' : 'private',
    })),
    [step, setStep] = useState(0),
    [dirty, setDirty] = useState(false),
    [playableDirty, setPlayableDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [confirm, setConfirm] = useState<'submit' | 'leave' | 'archive' | null>(null),
    [versionsOpen, setVersionsOpen] = useState(false);
  const [hydration, setHydration] = useState(0);
  const playableFlush = useRef<(() => Promise<void>) | null>(null);
  const baseline = useRef<AdventureDraft | null>(null);
  const acknowledged = useRef<Adventure | null>(null);
  const reloadAllowed = useRef(false);
  const versions = useResource<
    { id: string; version: number; createdAt: string; snapshot: Adventure }[]
  >(versionsOpen && !isNew ? `/studio/adventures/${id}/versions` : null);
  useEffect(() => {
    if (resource.data && resource.data.id === id && resource.data !== acknowledged.current) {
      if (baseline.current && dirty && !reloadAllowed.current) return;
      reloadAllowed.current = false;
      const next = toDraft(resource.data);
      baseline.current = next;
      setDraft(next);
      setDirty(false);
      setHydration((value) => value + 1);
    }
  }, [resource.data]);
  const autosave = useDraftAutosave<AdventureDraft, Adventure>({
    enabled: !isNew && hydration > 0,
    identity: `${id}:${hydration}`,
    draft,
    baseline: baseline.current || draft,
    revision: resource.data?.editRevision || 1,
    initialResult: resource.data!,
    validate: (value) => adventureSchema.safeParse(value).success,
    persist: async (value, revision) => {
      const result = await api<Adventure>(`/studio/adventures/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...value, expectedEditRevision: revision }),
      });
      return { result, revision: result.editRevision! };
    },
    onAcknowledged: (result, stillDirty) => {
      acknowledged.current = result;
      resource.setData(result);
      setDirty(stillDirty);
    },
  });
  useEffect(() => {
    if (!isNew && hydration > 0) setDirty(autosave.dirty);
  }, [autosave.dirty, hydration, isNew]);
  function reloadDraft() {
    if (window.confirm(t('Заменить локальные изменения серверной версией?'))) {
      reloadAllowed.current = true;
      resource.reload();
    }
  }
  useDirtyWarning(dirty || playableDirty);
  const change = <K extends keyof AdventureDraft>(key: K, value: AdventureDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setDirty(true);
  };
  const content = <K extends keyof AdventureDraft['content']>(
    key: K,
    value: AdventureDraft['content'][K],
  ) => {
    setDraft((d) => ({ ...d, content: { ...d.content, [key]: value } }));
    setDirty(true);
  };
  async function save() {
    setError('');
    setBusy(true);
    try {
      if (!isNew) {
        const saved = await autosave.flush();
        if (playableFlush.current) await playableFlush.current();
        toast(t('Черновик сохранён'));
        return saved;
      }
      const saved = await api<Adventure>(
        isNew ? '/studio/adventures' : `/studio/adventures/${id}`,
        { method: isNew ? 'POST' : 'PATCH', body: JSON.stringify(draft) },
      );
      setDirty(false);
      resource.setData(saved);
      toast(t('Черновик сохранён'));
      if (isNew) router.replace(`/studio/adventures/${saved.id}`);
      return saved;
    } catch (e) {
      setError(t(errorMessage(e)));
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function publish() {
    setConfirm(null);
    const saved = await save();
    if (!saved) return;
    setBusy(true);
    try {
      if (playableFlush.current) await playableFlush.current();
      const result = await api<Adventure>(`/studio/adventures/${saved.id}/submit`, {
        method: 'POST',
        body: '{}',
      });
      resource.setData(result);
      toast(t('История отправлена на модерацию'));
    } catch (e) {
      setError(t(errorMessage(e)));
    } finally {
      setBusy(false);
    }
  }
  async function duplicate() {
    setBusy(true);
    setError('');
    try {
      await autosave.flush();
      if (playableFlush.current) await playableFlush.current();
      const copy = await api<Adventure>(`/studio/adventures/${id}/duplicate`, {
        method: 'POST',
        body: '{}',
      });
      toast(t('Создана отдельная копия'));
      router.push(`/studio/adventures/${copy.id}`);
    } catch (e) {
      setError(t(errorMessage(e)));
    } finally {
      setBusy(false);
    }
  }
  async function setStatus(status: 'draft' | 'archived') {
    setBusy(true);
    setError('');
    setConfirm(null);
    try {
      const saved = await autosave.flush();
      if (playableFlush.current) await playableFlush.current();
      const result = await api<Adventure>(`/studio/adventures/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status, expectedEditRevision: saved.editRevision }),
      });
      resource.setData(result);
      toast(t('Видимость обновлена'));
    } catch (e) {
      setError(t(errorMessage(e)));
    } finally {
      setBusy(false);
    }
  }
  const savedOriginal = resource.data;
  const metadataChanged =
    !savedOriginal ||
    draft.title !== savedOriginal.title ||
    draft.synopsis !== savedOriginal.synopsis ||
    draft.sourceLanguage !== savedOriginal.sourceLanguage ||
    JSON.stringify(draft.tags) !== JSON.stringify(savedOriginal.tags);
  const previewText = selectAdventureText(
    {
      ...draft,
      sourceRevision: savedOriginal?.sourceRevision || 1,
      translations: metadataChanged ? {} : savedOriginal.translations,
    },
    locale,
  );
  const status = resource.data?.status || 'draft';
  if (resource.loading) return <Loading />;
  if (resource.error) return <ErrorBox message={resource.error} retry={resource.reload} />;
  return (
    <>
      <div className="row">
        <Button
          variant="ghost"
          onClick={() => (dirty || playableDirty ? setConfirm('leave') : router.push('/studio'))}
        >
          <ArrowLeft size={16} />
          {t('В мастерскую')}
        </Button>
        <Badge tone={status === 'published' ? 'green' : ''}>{t(statuses[status])}</Badge>
        <span className="muted">
          {dirty || playableDirty
            ? t('Есть несохранённые изменения')
            : isNew
              ? t('Новая история')
              : t('Все изменения сохранены')}
        </span>
      </div>
      <PageHeading
        eyebrow={t('РЕДАКТОР ПРИКЛЮЧЕНИЯ')}
        title={draft.title || t('Новая история')}
        description={t('Создайте мир, в который захочется шагнуть.')}
        action={
          <Button busy={busy} onClick={() => void save()}>
            <Save size={17} />
            {t('Сохранить черновик')}
          </Button>
        }
      />
      {status === 'published' && (
        <div className="notice">
          {t(
            'Опубликованная версия сохранена отдельно. Новые изменения станут черновиком и снова пройдут проверку.',
          )}
        </div>
      )}
      <nav className={styles.steps} aria-label={t('Шаги создания приключения')}>
        {steps.map((label, i) => (
          <button
            type="button"
            key={label}
            className={i === step ? styles.stepActive : ''}
            aria-current={i === step ? 'step' : undefined}
            onClick={() => setStep(i)}
          >
            <span>{i + 1}</span>
            {t(label)}
          </button>
        ))}
      </nav>
      <AutosaveStatus
        status={autosave.status}
        enabled={!isNew && hydration > 0}
        retry={() => {
          void autosave.flush().catch(() => {});
        }}
        reload={reloadDraft}
      />
      <ErrorBox message={error} />
      <form
        method="post"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void save();
        }}
        className="stack"
      >
        <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <Panel>
            <div className={styles.editorTitle}>
              <span>0{step + 1}</span>
              <div>
                <h2>{t(steps[step])}</h2>
                <p>
                  {
                    [
                      t('Дайте истории имя и пригласите читателя внутрь.'),
                      t('Задайте атмосферу и законы вашего мира.'),
                      t('Опиши локации и добавь проверяемую игровую карту.'),
                      t('Добавьте жителей мира из своей библиотеки.'),
                      t('Определите, где и с чего начнётся приключение.'),
                      t('Позаботьтесь о комфортном опыте будущих игроков.'),
                      t('Проверь историю и запусти отдельную приватную тестовую версию.'),
                      t('Проверьте готовность истории и выберите, кто её увидит.'),
                    ][step]
                  }
                </p>
              </div>
            </div>
            {step === 0 && (
              <div className="stack">
                <Field
                  label={t('Язык оригинала')}
                  hint={t(
                    'Пишите историю один раз. Если актуального перевода нет, читатели увидят оригинал.',
                  )}
                >
                  <Select
                    value={draft.sourceLanguage}
                    onChange={(e) =>
                      change('sourceLanguage', e.target.value as AdventureDraft['sourceLanguage'])
                    }
                  >
                    <option value="ru">{t('Русский')}</option>
                    <option value="uk">{t('Українська')}</option>
                    <option value="en">{t('English')}</option>
                  </Select>
                </Field>
                <Field label={t('Название приключения')}>
                  <Input
                    required
                    minLength={2}
                    maxLength={120}
                    value={draft.title}
                    onChange={(e) => change('title', e.target.value)}
                    placeholder={t('Например, Тайна старой обсерватории')}
                  />
                </Field>
                <Field
                  label={t('Синопсис')}
                  hint={t('Что ждёт игрока? Не раскрывайте главную тайну.')}
                >
                  <Textarea
                    maxLength={4000}
                    value={draft.synopsis}
                    onChange={(e) => change('synopsis', e.target.value)}
                    placeholder={t('Когда над городом погасла последняя звезда…')}
                  />
                </Field>
                <div className="field-grid">
                  <Field label={t('Жанр')}>
                    <Select value={draft.genre} onChange={(e) => change('genre', e.target.value)}>
                      {[
                        ...new Set([
                          draft.genre,
                          ...(genres.data || ['Тайна', 'Фэнтези', 'Приключение', 'Драма']),
                        ]),
                      ].map((g) => (
                        <option key={g} value={g}>
                          {taxonomy(g)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={t('Сложность')}>
                    <Select
                      value={draft.difficulty}
                      onChange={(e) =>
                        change('difficulty', e.target.value as AdventureDraft['difficulty'])
                      }
                    >
                      <option value="Легко">{t('Легко')}</option>
                      <option value="Средне">{t('Средне')}</option>
                      <option value="Сложно">{t('Сложно')}</option>
                    </Select>
                  </Field>
                  <Field label={t('Минимум игроков')}>
                    <Input
                      type="number"
                      min={1}
                      max={4}
                      value={draft.playersMin}
                      onChange={(e) => change('playersMin', Number(e.target.value))}
                    />
                  </Field>
                  <Field label={t('Максимум игроков')}>
                    <Input
                      type="number"
                      min={draft.playersMin}
                      max={4}
                      value={draft.playersMax}
                      onChange={(e) => change('playersMax', Number(e.target.value))}
                    />
                  </Field>
                  <Field label={t('Продолжительность')}>
                    <Input
                      maxLength={80}
                      value={draft.duration}
                      onChange={(e) => change('duration', e.target.value)}
                    />
                  </Field>
                  <fieldset className="stack">
                    <legend>{t('Теги')}</legend>
                    <ErrorBox message={tagDefinitions.error} retry={tagDefinitions.reload} />
                    <div className="chip-list">
                      {tagDefinitions.data?.map((tag) => {
                        const checked = draft.tags.some(
                          (value) =>
                            findControlledTag(value, tagDefinitions.data ?? [])?.id === tag.id,
                        );
                        return (
                          <Button
                            key={tag.id}
                            type="button"
                            variant={checked ? 'primary' : 'secondary'}
                            aria-pressed={checked}
                            onClick={() =>
                              change(
                                'tags',
                                checked
                                  ? draft.tags.filter(
                                      (value) =>
                                        findControlledTag(value, tagDefinitions.data ?? [])?.id !==
                                        tag.id,
                                    )
                                  : [...draft.tags, tag.id].slice(0, 12),
                              )
                            }
                          >
                            {tag.labels[locale]}
                          </Button>
                        );
                      })}
                    </div>
                    <Field label={t('Свои теги')} hint={t('Через запятую, до 12 тегов')}>
                      <Input
                        value={draft.tags
                          .filter((value) => !findControlledTag(value, tagDefinitions.data ?? []))
                          .join(', ')}
                        onChange={(e) =>
                          change(
                            'tags',
                            [
                              ...draft.tags.filter((value) =>
                                findControlledTag(value, tagDefinitions.data ?? []),
                              ),
                              ...e.target.value.split(',').map((value) => value.trim()),
                            ].slice(0, 12),
                          )
                        }
                      />
                    </Field>
                  </fieldset>
                </div>
                <Field label={t('Обложка из коллекции')}>
                  <Select
                    value={draft.cover}
                    onChange={(e) => change('cover', e.target.value as AdventureDraft['cover'])}
                  >
                    <option value="observatory">{t('Старая обсерватория')}</option>
                    <option value="forest">{t('Шёпот леса')}</option>
                    <option value="sea">{t('Туманный порт')}</option>
                    <option value="city">{t('Город историй')}</option>
                  </Select>
                </Field>
                <MediaPicker
                  value={draft.coverAssetId}
                  onChange={(id) => change('coverAssetId', id)}
                />
              </div>
            )}
            {step === 1 && (
              <div className="stack">
                <Field
                  label={t('Мир и атмосфера')}
                  hint={t('Где происходит история, какие у мира особенности?')}
                >
                  <Textarea
                    rows={8}
                    maxLength={12000}
                    value={draft.content.world}
                    onChange={(e) => content('world', e.target.value)}
                  />
                </Field>
                <Field
                  label={t('Правила мира')}
                  hint={t('Что возможно, что запрещено и какие последствия важны?')}
                >
                  <Textarea
                    rows={6}
                    maxLength={8000}
                    value={draft.content.rules}
                    onChange={(e) => content('rules', e.target.value)}
                  />
                </Field>
              </div>
            )}
            {step === 2 && (
              <div className="stack">
                {draft.content.locations.map((location, i) => (
                  <div className={styles.nestedCard} key={location.id}>
                    <div className="row">
                      <MapPin size={18} />
                      <h3>
                        {t('Локация ')}
                        {i + 1}
                      </h3>
                      <Button
                        variant="ghost"
                        type="button"
                        aria-label={t('Удалить локацию {name}', {
                          name: location.name,
                        })}
                        onClick={() => {
                          const scenes = draft.content.scenes.filter(
                            (s) => s.locationId !== location.id,
                          );
                          setDraft((d) => ({
                            ...d,
                            content: {
                              ...d.content,
                              locations: d.content.locations.filter((l) => l.id !== location.id),
                              scenes,
                              startSceneId: scenes.some((s) => s.id === d.content.startSceneId)
                                ? d.content.startSceneId
                                : '',
                            },
                          }));
                          setDirty(true);
                        }}
                      >
                        <Trash2 size={16} />
                      </Button>
                    </div>
                    <Field label={t('Название локации')}>
                      <Input
                        required
                        maxLength={120}
                        value={location.name}
                        onChange={(e) =>
                          content(
                            'locations',
                            draft.content.locations.map((l) =>
                              l.id === location.id ? { ...l, name: e.target.value } : l,
                            ),
                          )
                        }
                      />
                    </Field>
                    <Field label={t('Описание локации')}>
                      <Textarea
                        maxLength={6000}
                        value={location.description}
                        onChange={(e) =>
                          content(
                            'locations',
                            draft.content.locations.map((l) =>
                              l.id === location.id ? { ...l, description: e.target.value } : l,
                            ),
                          )
                        }
                      />
                    </Field>
                  </div>
                ))}
                {!draft.content.locations.length && (
                  <p className="muted">
                    {t('Добавьте хотя бы одну локацию: двор, зал обсерватории или забытый архив.')}
                  </p>
                )}
                <Button
                  variant="secondary"
                  type="button"
                  disabled={draft.content.locations.length >= 30}
                  onClick={() =>
                    content('locations', [
                      ...draft.content.locations,
                      {
                        id: crypto.randomUUID(),
                        name: t('Локация {number}', {
                          number: draft.content.locations.length + 1,
                        }),
                        description: '',
                      },
                    ])
                  }
                >
                  <Plus size={16} />
                  {t('Добавить локацию')}
                </Button>
              </div>
            )}
            {step === 3 && (
              <div className="stack">
                <div className="notice">
                  {t(
                    'NPC — жители вашего мира. Герои игроков создаются отдельно в разделе «Мои герои».',
                  )}
                </div>
                <ErrorBox message={npcs.error} retry={npcs.reload} />
                {npcs.loading ? (
                  <Loading />
                ) : npcs.data?.length ? (
                  <div className={styles.npcSelection}>
                    {npcs.data.map((n) => (
                      <label className={styles.npcOption} key={n.id}>
                        <input
                          type="checkbox"
                          checked={draft.content.npcIds.includes(n.id)}
                          onChange={(e) =>
                            content(
                              'npcIds',
                              e.target.checked
                                ? [...draft.content.npcIds, n.id]
                                : draft.content.npcIds.filter((id) => id !== n.id),
                            )
                          }
                        />
                        <span className={styles.avatar}>{selectNpcText(n, locale).name[0]}</span>
                        <span>
                          <strong>{selectNpcText(n, locale).name}</strong>
                          <small>{selectNpcText(n, locale).role || t('Житель мира')}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="muted">
                    {t(
                      'У вас пока нет NPC. Сохраните черновик, затем создайте персонажа в библиотеке.',
                    )}
                  </p>
                )}
                <Link
                  href="/studio/npcs/new"
                  className="text-link"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Plus size={16} />
                  {t('Создать NPC в новой вкладке')}
                </Link>
                <Button variant="ghost" type="button" onClick={npcs.reload}>
                  {t('Обновить библиотеку')}
                </Button>
              </div>
            )}
            {step === 4 && (
              <div className="stack">
                {!draft.content.locations.length ? (
                  <div className="notice">
                    {t('Сначала добавьте локацию на шаге 3.')}
                    <Button variant="ghost" type="button" onClick={() => setStep(2)}>
                      {t('К локациям')}
                    </Button>
                  </div>
                ) : (
                  <>
                    {draft.content.scenes.map((scene, i) => (
                      <div className={styles.nestedCard} key={scene.id}>
                        <div className="row">
                          <BookOpen size={18} />
                          <h3>
                            {t('Сцена ')}
                            {i + 1}
                          </h3>
                          <Button
                            variant="ghost"
                            type="button"
                            aria-label={t('Удалить сцену {name}', {
                              name: scene.name,
                            })}
                            onClick={() => {
                              content(
                                'scenes',
                                draft.content.scenes.filter((s) => s.id !== scene.id),
                              );
                              if (draft.content.startSceneId === scene.id)
                                content('startSceneId', '');
                            }}
                          >
                            <Trash2 size={16} />
                          </Button>
                        </div>
                        <div className="field-grid">
                          <Field label={t('Название сцены')}>
                            <Input
                              required
                              maxLength={120}
                              value={scene.name}
                              onChange={(e) =>
                                content(
                                  'scenes',
                                  draft.content.scenes.map((s) =>
                                    s.id === scene.id ? { ...s, name: e.target.value } : s,
                                  ),
                                )
                              }
                            />
                          </Field>
                          <Field label={t('Локация сцены')}>
                            <Select
                              value={scene.locationId}
                              onChange={(e) =>
                                content(
                                  'scenes',
                                  draft.content.scenes.map((s) =>
                                    s.id === scene.id ? { ...s, locationId: e.target.value } : s,
                                  ),
                                )
                              }
                            >
                              {draft.content.locations.map((l) => (
                                <option value={l.id} key={l.id}>
                                  {l.name}
                                </option>
                              ))}
                            </Select>
                          </Field>
                        </div>
                        <Field label={t('Начальная ситуация')}>
                          <Textarea
                            rows={5}
                            maxLength={6000}
                            value={scene.description}
                            onChange={(e) =>
                              content(
                                'scenes',
                                draft.content.scenes.map((s) =>
                                  s.id === scene.id ? { ...s, description: e.target.value } : s,
                                ),
                              )
                            }
                          />
                        </Field>
                      </div>
                    ))}
                    <Button
                      variant="secondary"
                      type="button"
                      disabled={draft.content.scenes.length >= 50}
                      onClick={() => {
                        const scene = {
                          id: crypto.randomUUID(),
                          name: t('Сцена {number}', {
                            number: draft.content.scenes.length + 1,
                          }),
                          locationId: draft.content.locations[0].id,
                          description: '',
                        };
                        content('scenes', [...draft.content.scenes, scene]);
                        if (!draft.content.startSceneId) content('startSceneId', scene.id);
                      }}
                    >
                      <Plus size={16} />
                      {t('Добавить сцену')}
                    </Button>
                    {draft.content.scenes.length > 0 && (
                      <Field label={t('Стартовая сцена')}>
                        <Select
                          value={draft.content.startSceneId}
                          onChange={(e) => content('startSceneId', e.target.value)}
                        >
                          <option value="">{t('Выберите сцену')}</option>
                          {draft.content.scenes.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    )}
                  </>
                )}
              </div>
            )}
            {step === 5 && (
              <div className="stack">
                <p className="muted">
                  {t(
                    'Укажите темы и границы истории. Эти сведения будут видны в карточке приключения.',
                  )}
                </p>
                {[
                  'Без откровенного контента',
                  'Неоткровенная романтика',
                  'Фантастическое насилие',
                  'Тревожная атмосфера',
                  'Без жестокости к животным',
                ].map((item) => (
                  <label key={item} className={styles.checkRow}>
                    <input
                      type="checkbox"
                      checked={draft.content.boundaries.includes(item)}
                      onChange={(e) =>
                        content(
                          'boundaries',
                          e.target.checked
                            ? [...draft.content.boundaries, item]
                            : draft.content.boundaries.filter((x) => x !== item),
                        )
                      }
                    />
                    {t(item)}
                  </label>
                ))}
                <Field
                  label={t('Все границы и предупреждения')}
                  hint={t('Одна строка — одно предупреждение, максимум 20')}
                >
                  <Textarea
                    value={draft.content.boundaries.join('\n')}
                    onChange={(e) => content('boundaries', e.target.value.split('\n').slice(0, 20))}
                  />
                </Field>
                <div className="notice">
                  <ShieldCheck size={18} />
                  {t(
                    'Dreamwalk — приключения, загадки и отношения без откровенного контента. Публикация требует ручной проверки.',
                  )}
                </div>
              </div>
            )}
            {step === 6 && (
              <div className="stack">
                <div
                  className={styles.previewCover}
                  style={{
                    backgroundImage: `linear-gradient(0deg,rgba(8,15,16,.9),transparent),url("${coverUrl(draft)}")`,
                  }}
                >
                  <Badge>{taxonomy(draft.genre)}</Badge>
                  <h2>{previewText.title || t('Название вашей истории')}</h2>
                  <p>
                    {previewText.synopsis ||
                      t('Добавьте синопсис, чтобы представить приключение читателям.')}
                  </p>
                  <span>
                    {draft.playersMin}–{draft.playersMax} {t(' игроков · ')}
                    {taxonomy(draft.duration)} · {t(draft.difficulty)}
                  </span>
                </div>
                <h3>{t('Мир истории')}</h3>
                <p className={styles.preWrap}>
                  {draft.content.world || t('Описание пока не добавлено.')}
                </p>
                <div className={styles.summaryGrid}>
                  <div>
                    <MapPin />
                    <strong>{draft.content.locations.length}</strong>
                    <span>{t('локаций')}</span>
                  </div>
                  <div>
                    <Users />
                    <strong>{draft.content.npcIds.length}</strong>
                    <span>{t('персонажей')}</span>
                  </div>
                  <div>
                    <BookOpen />
                    <strong>{draft.content.scenes.length}</strong>
                    <span>{t('сцен')}</span>
                  </div>
                </div>
                {draft.content.boundaries.length > 0 && (
                  <p className="muted">{draft.content.boundaries.join(' · ')}</p>
                )}
                <p className="muted">
                  {t(
                    'Игровая карта и тестовый запуск доступны ниже. История без карты остаётся литературным черновиком.',
                  )}
                </p>
              </div>
            )}
            {step === 7 && (
              <div className="stack">
                <div className={styles.readiness}>
                  {[
                    [t('Название'), draft.title.trim().length >= 2],
                    [t('Синопсис'), !!draft.synopsis.trim()],
                    [t('Описание мира'), !!draft.content.world.trim()],
                    [t('Хотя бы одна локация'), draft.content.locations.length > 0],
                    [t('Стартовая сцена'), !!draft.content.startSceneId],
                  ].map(([label, ready]) => (
                    <div key={String(label)}>
                      <span className={ready ? styles.ready : styles.notReady}>
                        {ready ? <Check size={16} /> : <span>—</span>}
                      </span>
                      {label}
                    </div>
                  ))}
                </div>
                <p className="muted">
                  {t(
                    'Это подсказки для подготовки. Полную проверку связей и прав выполняет сервер при отправке.',
                  )}
                </p>
                <Field label={t('Режим публикации')}>
                  <Select
                    value={draft.visibility}
                    onChange={(e) =>
                      change('visibility', e.target.value as AdventureDraft['visibility'])
                    }
                  >
                    <option value="private">{t('Приватное — только приглашённые')}</option>
                    <option value="public">{t('Публичное — через модерацию')}</option>
                  </Select>
                </Field>
                {draft.visibility === 'private' ? (
                  <>
                    <div className="notice">
                      {t(
                        'Доступно только вам и пользователям, принявшим личное приглашение. Модерация не требуется.',
                      )}
                    </div>
                    {resource.data?.visibility === 'public' && (
                      <div className="notice">
                        {t(
                          'Смена публичного режима на приватный уберёт историю из каталога. Для повторной публикации понадобится новая модерация.',
                        )}
                      </div>
                    )}
                    <Button type="button" busy={busy} onClick={() => void save()}>
                      <Save size={16} />
                      {t('Сохранить приватное приключение')}
                    </Button>
                  </>
                ) : (
                  <>
                    <div className="notice">
                      {t(
                        'После одобрения история появится в общем каталоге. Старое одобрение сохраняется, пока новые правки проходят проверку.',
                      )}
                    </div>
                    <Button
                      type="button"
                      busy={busy}
                      disabled={(status === 'pending_review' || status === 'published') && !dirty}
                      onClick={() => setConfirm('submit')}
                    >
                      <Send size={16} />
                      {status === 'pending_review' && !dirty
                        ? t('Ожидает проверки')
                        : status === 'published' && !dirty
                          ? t('Опубликовано')
                          : t('Отправить на модерацию')}
                    </Button>
                  </>
                )}
                {!isNew && (
                  <div className="row">
                    <Button type="button" variant="secondary" onClick={() => setVersionsOpen(true)}>
                      <Eye size={16} />
                      {t('История версий')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      busy={busy}
                      onClick={() => void duplicate()}
                    >
                      <Copy size={16} />
                      {t('Создать копию')}
                    </Button>
                  </div>
                )}
                {!isNew && status !== 'archived' && (
                  <Button type="button" variant="ghost" onClick={() => setConfirm('archive')}>
                    {t('Убрать в архив')}
                  </Button>
                )}
              </div>
            )}
          </Panel>
          <div className="form-actions">
            <Button
              type="button"
              variant="secondary"
              disabled={step === 0}
              onClick={() => setStep((s) => s - 1)}
            >
              <ArrowLeft size={16} />
              {t('Назад')}
            </Button>
            <span className="muted">
              {t('Шаг')}
              {step + 1} {t('из')}
              {steps.length}
            </span>
            {step < 7 ? (
              <Button type="button" onClick={() => setStep((s) => s + 1)}>
                {t('Продолжить')}
                <ArrowRight size={16} />
              </Button>
            ) : (
              <Button type="submit" variant="secondary" busy={busy}>
                <Save size={16} />
                {t('Сохранить')}
              </Button>
            )}
          </div>
        </fieldset>
      </form>
      <div hidden={step !== 2 && step !== 6}>
        <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          {isNew ? (
            <div className="notice">
              {t('Сначала сохрани историю, затем добавь игровую карту.')}
            </div>
          ) : (
            <PlayableMapEditor
              adventureId={id}
              title={draft.title}
              npcs={npcs.data || []}
              locations={draft.content.locations}
              onDirty={setPlayableDirty}
              flushRef={playableFlush}
              preview={step === 6}
            />
          )}
        </fieldset>
      </div>
      {step === 7 &&
        draft.visibility === 'private' &&
        (isNew || resource.data?.visibility !== 'private' ? (
          <div className="notice">{t('Сначала сохраните историю и выбранный режим доступа.')}</div>
        ) : (
          status !== 'archived' && <InvitationManager adventureId={id} />
        ))}
      {confirm === 'submit' && (
        <Modal title={t('Отправить историю на проверку?')} onClose={() => setConfirm(null)}>
          <p>
            {t(
              'Текущий черновик будет сохранён и отправлен модератору. Публичной история станет только после одобрения.',
            )}
          </p>
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setConfirm(null)}>
              {t('Отмена')}
            </Button>
            <Button onClick={() => void publish()}>{t('Сохранить и отправить')}</Button>
          </div>
        </Modal>
      )}
      {confirm === 'leave' && (
        <Modal title={t('Есть несохранённые изменения')} onClose={() => setConfirm(null)}>
          <p>{t('Остаться в редакторе или выйти без сохранения?')}</p>
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setConfirm(null)}>
              {t('Остаться')}
            </Button>
            <Button variant="danger" onClick={() => router.push('/studio')}>
              {t('Выйти без сохранения')}
            </Button>
          </div>
        </Modal>
      )}
      {confirm === 'archive' && (
        <Modal title={t('Переместить в архив?')} onClose={() => setConfirm(null)}>
          <p>
            {t(
              'История перестанет отображаться в публичном каталоге. Черновик останется в вашей мастерской.',
            )}
          </p>
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setConfirm(null)}>
              {t('Отмена')}
            </Button>
            <Button variant="danger" onClick={() => void setStatus('archived')}>
              {t('В архив')}
            </Button>
          </div>
        </Modal>
      )}
      {versionsOpen && (
        <Modal title={t('Опубликованные версии')} onClose={() => setVersionsOpen(false)}>
          <ErrorBox message={versions.error} retry={versions.reload} />
          {versions.loading ? (
            <Loading />
          ) : versions.data?.length ? (
            versions.data.map((v) => (
              <div className={styles.nestedCard} key={v.id}>
                <Badge>
                  {t('Версия ')}
                  {v.version}
                </Badge>
                <h3>{v.snapshot?.title || draft.title}</h3>
                <p>{v.snapshot?.synopsis}</p>
                <small>{date(v.createdAt)}</small>
              </div>
            ))
          ) : (
            <p>
              {t('Опубликованных версий пока нет. Первая появится после одобрения модератором.')}
            </p>
          )}
        </Modal>
      )}
    </>
  );
}

function NpcLibrary() {
  const { t, locale } = useT();
  const items = useResource<Npc[]>('/npcs');
  return (
    <>
      <PageHeading
        eyebrow={t('СТУДИЯ / ПЕРСОНАЖИ')}
        title={t('Жители ваших миров')}
        description={t(
          'Не просто имена в истории. Характеры, секреты и собственный взгляд на мир.',
        )}
        action={
          <ButtonLink href="/studio/npcs/new">
            <Plus size={17} />
            {t('Создать NPC')}
          </ButtonLink>
        }
      />
      <StudioTabs npcs />
      <ErrorBox message={items.error} retry={items.reload} />
      {items.loading ? (
        <Loading />
      ) : items.data?.length ? (
        <div className={styles.npcCards}>
          {items.data.map((n) => (
            <Link href={`/studio/npcs/${n.id}`} key={n.id} className={styles.npcCard}>
              {n.portraitAssetId ? (
                <img className={styles.portrait} src={assetUrl(n.portraitAssetId)} alt="" />
              ) : (
                <div className={styles.portraitLetter}>{selectNpcText(n, locale).name[0]}</div>
              )}
              <Badge>{t('Личный')}</Badge>
              <h2>{selectNpcText(n, locale).name}</h2>
              <p>{selectNpcText(n, locale).role || t('Роль пока не выбрана')}</p>
              <small>
                {selectNpcText(n, locale).description ||
                  selectNpcText(n, locale).personality ||
                  t('Характер этой истории ещё предстоит раскрыть.')}
              </small>
              <span className="text-link">
                {t('Редактировать')}
                <ArrowRight size={16} />
              </span>
            </Link>
          ))}
        </div>
      ) : (
        !items.error && (
          <Empty
            title={t('Каждому миру нужны жители')}
            description={t(
              'Создайте первого NPC, а затем добавьте его в приключение. Секреты персонажа доступны только автору и модератору.',
            )}
            action={<ButtonLink href="/studio/npcs/new">{t('Создать персонажа')}</ButtonLink>}
          />
        )
      )}
    </>
  );
}
type NpcDraft = Omit<Npc, 'id' | 'createdAt' | 'updatedAt' | 'editRevision'>;
const blankNpc: NpcDraft = {
  description: '',
  sourceLanguage: 'ru',
  sourceRevision: 1,
  translations: {},
  name: '',
  age: 25,
  role: '',
  personality: '',
  appearance: '',
  biography: '',
  secrets: '',
  greeting: '',
  modelProfileId: null,
  visibility: 'private',
  portraitAssetId: null,
};
function toNpcDraft(n: Npc): NpcDraft {
  return {
    description: n.description,
    sourceLanguage: n.sourceLanguage,
    sourceRevision: n.sourceRevision,
    translations: n.translations,
    name: n.name,
    age: n.age,
    role: n.role,
    personality: n.personality,
    appearance: n.appearance,
    biography: n.biography,
    secrets: n.secrets,
    greeting: n.greeting,
    modelProfileId: n.modelProfileId,
    visibility: 'private',
    portraitAssetId: n.portraitAssetId,
  };
}
function NpcEditor({ id }: { id: string }) {
  const { t, locale } = useT();
  const router = useRouter(),
    { toast } = useClient(),
    isNew = id === 'new',
    resource = useResource<Npc>(isNew ? null : `/npcs/${id}`),
    models = useResource<ModelProfile[]>('/models');
  const [draft, setDraft] = useState<NpcDraft>(() => ({ ...blankNpc, sourceLanguage: locale })),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [dirty, setDirty] = useState(false),
    [confirm, setConfirm] = useState(false),
    [leave, setLeave] = useState(false);
  const [hydration, setHydration] = useState(0);
  const baseline = useRef<NpcDraft | null>(null),
    acknowledged = useRef<Npc | null>(null),
    reloadAllowed = useRef(false);
  useDirtyWarning(dirty);
  useEffect(() => {
    if (resource.data && resource.data.id === id && resource.data !== acknowledged.current) {
      if (baseline.current && dirty && !reloadAllowed.current) return;
      reloadAllowed.current = false;
      const next = toNpcDraft(resource.data);
      baseline.current = next;
      setDraft(next);
      setDirty(false);
      setHydration((value) => value + 1);
    }
  }, [resource.data]);
  const autosave = useDraftAutosave<NpcDraft, Npc>({
    enabled: !isNew && hydration > 0,
    identity: `${id}:${hydration}`,
    draft,
    baseline: baseline.current || draft,
    revision: resource.data?.editRevision || 1,
    initialResult: resource.data!,
    validate: (value) => npcSchema.safeParse(value).success,
    persist: async (value, revision) => {
      const result = await api<Npc>(`/npcs/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...value, expectedEditRevision: revision }),
      });
      return { result, revision: result.editRevision! };
    },
    onAcknowledged: (result, stillDirty) => {
      acknowledged.current = result;
      resource.setData(result);
      setDirty(stillDirty);
    },
  });
  useEffect(() => {
    if (!isNew && hydration > 0) setDirty(autosave.dirty);
  }, [autosave.dirty, hydration, isNew]);
  function reloadDraft() {
    if (window.confirm(t('Заменить локальные изменения серверной версией?'))) {
      reloadAllowed.current = true;
      resource.reload();
    }
  }
  const change = <K extends keyof NpcDraft>(key: K, value: NpcDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setDirty(true);
  };
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (!isNew) {
        await autosave.flush();
        toast(t('NPC сохранён'));
        return;
      }
      const result = await api<Npc>(isNew ? '/npcs' : `/npcs/${id}`, {
        method: isNew ? 'POST' : 'PATCH',
        body: JSON.stringify(draft),
      });
      setDirty(false);
      toast(t('NPC сохранён'));
      if (isNew) router.replace(`/studio/npcs/${result.id}`);
      else resource.setData(result);
    } catch (e) {
      setError(t(errorMessage(e)));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    setError('');
    try {
      await api(`/npcs/${id}`, { method: 'DELETE' });
      toast(t('NPC удалён'));
      router.push('/studio/npcs');
    } catch (e) {
      setError(t(errorMessage(e)));
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  }
  if (resource.loading) return <Loading />;
  if (resource.error) return <ErrorBox message={resource.error} retry={resource.reload} />;
  return (
    <>
      <Button
        variant="ghost"
        onClick={() => (dirty ? setLeave(true) : router.push('/studio/npcs'))}
      >
        <ArrowLeft size={16} />
        {t('Библиотека NPC')}
      </Button>
      <PageHeading
        eyebrow={t('ПЕРСОНАЖ МИРА')}
        title={draft.name || t('Новый NPC')}
        description={t('Личность персонажа — отдельно от стиля повествования и модели AI.')}
      />
      <AutosaveStatus
        status={autosave.status}
        enabled={!isNew && hydration > 0}
        retry={() => {
          void autosave.flush().catch(() => {});
        }}
        reload={reloadDraft}
      />
      <ErrorBox message={error} />
      <form method="post" className="stack" onSubmit={(e) => void save(e)}>
        <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <Panel>
            <div className="field-grid">
              <Field label={t('Язык оригинала')}>
                <Select
                  value={draft.sourceLanguage}
                  onChange={(e) =>
                    change('sourceLanguage', e.target.value as NpcDraft['sourceLanguage'])
                  }
                >
                  <option value="uk">{t('Українська')}</option>
                  <option value="en">{t('English')}</option>
                  <option value="ru">{t('Русский')}</option>
                </Select>
              </Field>
              <Field label={t('Имя NPC')}>
                <Input
                  required
                  minLength={2}
                  maxLength={80}
                  value={draft.name}
                  onChange={(e) => change('name', e.target.value)}
                />
              </Field>
              <Field label={t('Возраст')} hint={t('Персонажи этой платформы — совершеннолетние.')}>
                <Input
                  type="number"
                  required
                  min={18}
                  max={10000}
                  value={draft.age}
                  onChange={(e) => change('age', Number(e.target.value))}
                />
              </Field>
              <Field label={t('Роль в мире')}>
                <Input
                  maxLength={120}
                  value={draft.role}
                  onChange={(e) => change('role', e.target.value)}
                  placeholder={t('Смотритель обсерватории')}
                />
              </Field>
            </div>
            <div className="stack">
              <div className="notice">
                {t(
                  'NPC доступен только автору. Читатели приключения увидят безопасное превью без секретов.',
                )}
              </div>
              <Field label={t('Публичное описание NPC')}>
                <Textarea
                  maxLength={4000}
                  value={draft.description}
                  onChange={(e) => change('description', e.target.value)}
                />
              </Field>
              <Field label={t('Характер')}>
                <Textarea
                  maxLength={4000}
                  value={draft.personality}
                  onChange={(e) => change('personality', e.target.value)}
                />
              </Field>
              <Field label={t('Внешность')}>
                <Textarea
                  maxLength={4000}
                  value={draft.appearance}
                  onChange={(e) => change('appearance', e.target.value)}
                />
              </Field>
              <Field label={t('Биография')}>
                <Textarea
                  maxLength={6000}
                  value={draft.biography}
                  onChange={(e) => change('biography', e.target.value)}
                />
              </Field>
              <Field
                label={t('Секреты и скрытые знания')}
                hint={t('Не показываются в публичной карточке. Только автор и модератор.')}
              >
                <Textarea
                  maxLength={6000}
                  value={draft.secrets}
                  onChange={(e) => change('secrets', e.target.value)}
                />
              </Field>
              <Field label={t('Первая реплика')}>
                <Textarea
                  maxLength={2000}
                  value={draft.greeting}
                  onChange={(e) => change('greeting', e.target.value)}
                />
              </Field>
              <Field label={t('Стиль поведения')}>
                <Select
                  value={draft.modelProfileId || ''}
                  onChange={(e) => change('modelProfileId', e.target.value || null)}
                >
                  <option value="">{t('Без предпочтения')}</option>
                  {models.data
                    ?.filter((m) => m.enabled)
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} — {m.description}
                      </option>
                    ))}
                </Select>
              </Field>
              <ErrorBox message={models.error} retry={models.reload} />
              <UploadField
                label={t('Загрузить портрет')}
                onUploaded={(asset) => change('portraitAssetId', asset.id)}
              />
              {draft.portraitAssetId && (
                <div className="row">
                  <img
                    className={styles.portrait}
                    src={assetUrl(draft.portraitAssetId)}
                    alt={t('Портрет NPC')}
                  />
                  <Button
                    variant="ghost"
                    type="button"
                    onClick={() => change('portraitAssetId', null)}
                  >
                    {t('Убрать портрет')}
                  </Button>
                </div>
              )}
            </div>
          </Panel>
          <div className="form-actions">
            <span className="muted">
              {dirty ? t('Есть несохранённые изменения') : t('Черновик персонажа')}
            </span>
            {!isNew && (
              <Button variant="danger" type="button" onClick={() => setConfirm(true)}>
                <Trash2 size={16} />
                {t('Удалить')}
              </Button>
            )}
            <Button busy={busy} type="submit">
              <Save size={16} />
              {t('Сохранить NPC')}
            </Button>
          </div>
        </fieldset>
      </form>
      {leave && (
        <Modal title={t('Есть несохранённые изменения')} onClose={() => setLeave(false)}>
          <p>{t('Остаться в редакторе или выйти без сохранения?')}</p>
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setLeave(false)}>
              {t('Остаться')}
            </Button>
            <Button variant="danger" onClick={() => router.push('/studio/npcs')}>
              {t('Выйти без сохранения')}
            </Button>
          </div>
        </Modal>
      )}
      {confirm && (
        <Modal title={t('Удалить персонажа?')} onClose={() => setConfirm(false)}>
          <p>
            {t(
              'Это действие нельзя отменить. Если NPC используется в приключении, сервер защитит связанные данные.',
            )}
          </p>
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setConfirm(false)}>
              {t('Отмена')}
            </Button>
            <Button variant="danger" busy={busy} onClick={() => void remove()}>
              {t('Удалить NPC')}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

const inviteStatuses: Record<Invitation['status'], string> = {
  pending: 'Ожидает ответа',
  accepted: 'Принято',
  declined: 'Отклонено',
  revoked: 'Отозвано',
};
function InvitationManager({ adventureId }: { adventureId: string }) {
  const { t } = useT(),
    { toast } = useClient(),
    date = useDate();
  const invitations = useResource<Invitation[]>(`/studio/adventures/${adventureId}/invitations`);
  const [handle, setHandle] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [revoke, setRevoke] = useState<Invitation | null>(null);
  async function invite(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/studio/adventures/${adventureId}/invitations`, {
        method: 'POST',
        body: JSON.stringify({ handle: handle.replace(/^@/, '').trim() }),
      });
      setHandle('');
      toast(t('Приглашение отправлено'));
      invitations.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function revokeInvite() {
    if (!revoke) return;
    setBusy(true);
    setError('');
    try {
      await api(`/studio/adventures/${adventureId}/invitations/${revoke.id}`, { method: 'DELETE' });
      setRevoke(null);
      toast(t('Приглашение отозвано'));
      invitations.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel>
      <h2>{t('Приглашения')}</h2>
      <p className="muted">
        {t(
          'Введите handle существующего пользователя без @. Приглашение нужно принять в библиотеке.',
        )}
      </p>
      <form method="post" className="stack" onSubmit={(e) => void invite(e)}>
        <Field label={t('Пригласить по handle')}>
          <Input
            required
            minLength={3}
            maxLength={31}
            pattern="@?[a-z0-9_]{3,30}"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            autoComplete="off"
            placeholder="handle"
          />
        </Field>
        <Button type="submit" busy={busy}>
          <Plus size={16} />
          {t('Пригласить')}
        </Button>
      </form>
      <ErrorBox message={error} />
      <ErrorBox message={invitations.error} retry={invitations.reload} />
      {invitations.loading ? (
        <Loading />
      ) : invitations.data?.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('Пользователь')}</th>
                <th>{t('Статус')}</th>
                <th>{t('Создан')}</th>
                <th>{t('Действие')}</th>
              </tr>
            </thead>
            <tbody>
              {invitations.data.map((invite) => (
                <tr key={invite.id}>
                  <td>
                    <strong>{invite.recipient.name}</strong>
                    <small>@{invite.recipient.handle}</small>
                  </td>
                  <td>
                    <Badge>{t(inviteStatuses[invite.status])}</Badge>
                  </td>
                  <td>{date(invite.createdAt)}</td>
                  <td>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={invite.status === 'revoked' || invite.status === 'declined'}
                      onClick={() => setRevoke(invite)}
                    >
                      {t('Отозвать')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        !invitations.error && <p className="muted">{t('Пока никто не приглашён')}</p>
      )}
      {revoke && (
        <Modal title={t('Отозвать приглашение?')} onClose={() => setRevoke(null)}>
          <p>
            {t(
              'Пользователь потеряет доступ к приватному приключению. Уже сохранённые данные автора останутся на месте.',
            )}
          </p>
          <p>
            {revoke.recipient.name} (@{revoke.recipient.handle})
          </p>
          <ErrorBox message={error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setRevoke(null)}>
              {t('Отмена')}
            </Button>
            <Button variant="danger" busy={busy} onClick={() => void revokeInvite()}>
              {t('Отозвать')}
            </Button>
          </div>
        </Modal>
      )}
    </Panel>
  );
}

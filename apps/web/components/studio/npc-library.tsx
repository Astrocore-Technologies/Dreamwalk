'use client';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  BookOpen,
  Feather,
  ImagePlus,
  LockKeyhole,
  MessageCircle,
  Pencil,
  Plus,
  Save,
  ShieldCheck,
  Trash2,
  UserRound,
  Users,
} from 'lucide-react';
import { npcSchema, selectNpcText, type Npc } from '@dreamwalk/contracts';
import { useT } from '@/lib/i18n';
import { api, assetUrl, errorMessage, useClient, useResource } from '@/lib/client';
import { useDraftAutosave } from '@/lib/use-draft-autosave';
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
  Select,
  UploadField,
} from '../ui';
import { CharacterSpriteControl } from '../visual-authoring/character-sprite-control';
import { MarkdownField } from '../markdown';
import { NpcTemplateField } from './npc-template-field';
import { AutosaveStatus } from './autosave-status';
import { npcDesignText } from './npc-design-copy';
import styles from './npc-library.module.css';

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
export function NpcLibrary({ tabs }: { tabs: ReactNode }) {
  const { t, locale } = useT();
  const text = (key: Parameters<typeof npcDesignText>[1]) => npcDesignText(locale, key);
  const items = useResource<Npc[]>('/npcs');
  return (
    <section className={styles.library} data-testid="npc-library">
      <header className={styles.libraryHero}>
        <div className={styles.heroCopy}>
          <h1>{text('title')}</h1>
          <p>{text('intro')}</p>
        </div>
      </header>
      <div className={styles.libraryToolbar}>
        {tabs}
        <ButtonLink href="/studio/npcs/new">
          <Plus size={19} />
          {t('Создать персонажа')}
        </ButtonLink>
      </div>
      <ErrorBox message={items.error} retry={items.reload} />
      {items.loading ? (
        <Loading />
      ) : items.data?.length ? (
        <div className={styles.cards}>
          {items.data.map((npc) => {
            const copy = selectNpcText(npc, locale);
            return (
              <Link href={`/studio/npcs/${npc.id}`} key={npc.id} className={styles.card}>
                <div className={styles.cardPortrait}>
                  {npc.portraitAssetId ? (
                    <img src={assetUrl(npc.portraitAssetId)} alt="" />
                  ) : (
                    <div className={styles.portraitPlaceholder}>
                      <UserRound size={56} strokeWidth={1} aria-hidden="true" />
                      <span>{text('portraitEmpty')}</span>
                    </div>
                  )}
                  <span className={styles.cardBadge}>
                    <Badge>{t('Личный')}</Badge>
                  </span>
                </div>
                <div className={styles.cardBody}>
                  <h2>{copy.name}</h2>
                  <p className={styles.cardRole}>
                    <Users size={18} aria-hidden="true" />
                    {copy.role || t('Роль пока не выбрана')}
                  </p>
                  <p className={styles.cardDescription}>
                    {copy.description ||
                      copy.personality ||
                      t('Характер этой истории ещё предстоит раскрыть.')}
                  </p>
                  <span className={styles.cardEdit}>
                    <Pencil size={19} />
                    {t('Редактировать')}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      ) : (
        !items.error && (
          <div className={styles.empty}>
            <Empty
              title={t('Каждому миру нужны жители')}
              description={t(
                'Создайте первого NPC, а затем добавьте его в приключение. Секреты персонажа доступны только автору и модератору.',
              )}
              action={<ButtonLink href="/studio/npcs/new">{t('Создать персонажа')}</ButtonLink>}
            />
          </div>
        )
      )}
    </section>
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
    characterProfile: n.characterProfile,
    characterPackageVersionId: n.characterPackageVersionId,
    appearance: n.appearance,
    biography: n.biography,
    secrets: n.secrets,
    greeting: n.greeting,
    modelProfileId: n.modelProfileId,
    visibility: 'private',
    portraitAssetId: n.portraitAssetId,
  };
}
export function NpcEditor({ id }: { id: string }) {
  const { t, locale } = useT();
  const text = (key: Parameters<typeof npcDesignText>[1]) => npcDesignText(locale, key);
  const [section, setSection] = useState<'character' | 'biography' | 'speech'>('character');
  const router = useRouter(),
    { toast } = useClient(),
    isNew = id === 'new',
    resource = useResource<Npc>(isNew ? null : `/npcs/${id}`);
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
    <section className={styles.editor} data-testid="npc-editor">
      <Button
        variant="ghost"
        onClick={() => (dirty ? setLeave(true) : router.push('/studio/npcs'))}
      >
        <ArrowLeft size={16} />
        {t('Библиотека NPC')}
      </Button>
      <header className={styles.editorHeader}>
        <h1>
          {draft.name || t('Новый NPC')} <span>· {text('worldCharacter')}</span>
        </h1>
        <AutosaveStatus
          status={autosave.status}
          enabled={!isNew && hydration > 0}
          retry={() => {
            void autosave.flush().catch(() => {});
          }}
          reload={reloadDraft}
        />
      </header>
      <ErrorBox message={error} />
      <form method="post" className={styles.editorForm} onSubmit={(e) => void save(e)}>
        <fieldset disabled={busy} className={styles.editorFields}>
          <div className={styles.identity}>
            <section className={styles.portraitPanel} aria-label={t('Портрет NPC')}>
              <div className={styles.editorPortrait}>
                {draft.portraitAssetId ? (
                  <img src={assetUrl(draft.portraitAssetId)} alt={t('Портрет NPC')} />
                ) : (
                  <div className={styles.portraitPlaceholder}>
                    <UserRound size={88} strokeWidth={1} aria-hidden="true" />
                    <span>{text('portraitEmpty')}</span>
                  </div>
                )}
              </div>
              <div className={styles.portraitActions}>
                <UploadField
                  label={t('Загрузить портрет')}
                  onUploaded={(asset) => change('portraitAssetId', asset.id)}
                />
                {draft.portraitAssetId && (
                  <Button
                    variant="ghost"
                    type="button"
                    onClick={() => change('portraitAssetId', null)}
                  >
                    {t('Убрать портрет')}
                  </Button>
                )}
              </div>
            </section>
            <section className={styles.identityFields} aria-label={text('worldCharacter')}>
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
              <MarkdownField
                label={t('Публичное описание NPC')}
                rows={3}
                maxLength={4000}
                value={draft.description}
                onChange={(e) => change('description', e.target.value)}
              />
              <MarkdownField
                label={t('Внешность')}
                rows={3}
                maxLength={4000}
                value={draft.appearance}
                onChange={(e) => change('appearance', e.target.value)}
              />
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
            </section>
          </div>
          <section className={styles.details} aria-label={text('details')}>
            <div className={styles.sectionTabs} role="group" aria-label={text('details')}>
              {(
                [
                  ['biography', BookOpen],
                  ['character', Feather],
                  ['speech', MessageCircle],
                ] as const
              ).map(([key, Icon]) => (
                <Button
                  key={key}
                  type="button"
                  variant="secondary"
                  aria-pressed={section === key}
                  aria-controls={`npc-section-${key}`}
                  onClick={() => setSection(key)}
                >
                  <Icon size={20} />
                  {text(key)}
                </Button>
              ))}
            </div>
            <div className={styles.detailsColumns}>
              <div>
                <div id="npc-section-character" hidden={section !== 'character'}>
                  <h2>{text('character')}</h2>
                  <NpcTemplateField
                    label={t('Характер')}
                    maxLength={4000}
                    value={draft.personality}
                    markdown
                    templates={['personality', 'motivation', 'reaction']}
                    onChange={(value) => change('personality', value)}
                  />
                </div>
                <div id="npc-section-biography" hidden={section !== 'biography'}>
                  <h2>{text('biography')}</h2>
                  <MarkdownField
                    label={t('Биография')}
                    rows={7}
                    maxLength={6000}
                    value={draft.biography}
                    onChange={(e) => change('biography', e.target.value)}
                  />
                </div>
                <div id="npc-section-speech" hidden={section !== 'speech'}>
                  <h2>{text('speech')}</h2>
                  <NpcTemplateField
                    label={t('Первая реплика')}
                    maxLength={2000}
                    value={draft.greeting}
                    templates={['example']}
                    onChange={(value) => change('greeting', value)}
                  />
                </div>
              </div>
              <section className={styles.secrets}>
                <h2>
                  <LockKeyhole size={21} />
                  {text('secrets')}
                </h2>
                <p className={styles.privacyLabel}>
                  <ShieldCheck size={16} />
                  {text('private')}
                </p>
                <MarkdownField
                  label={t('Секреты и скрытые знания')}
                  hint={t('Не показываются в публичной карточке. Только автор и модератор.')}

                  rows={7}
                  maxLength={6000}
                  value={draft.secrets}
                  onChange={(e) => change('secrets', e.target.value)}
                />
              </section>
            </div>
          </section>
          <p className={styles.privacyNote}>
            <ShieldCheck size={17} aria-hidden="true" />
            {t(
              'NPC доступен только автору. Читатели приключения увидят безопасное превью без секретов.',
            )}
          </p>
          <div className={styles.formActions}>
            <span className="muted">
              {dirty ? t('Есть несохранённые изменения') : t('Черновик персонажа')}
            </span>
            {!isNew && (
              <Button variant="danger" type="button" onClick={() => setConfirm(true)}>
                <Trash2 size={16} />
                {t('Удалить')}
              </Button>
            )}
            <Button
              variant="secondary"
              type="button"
              onClick={() => (dirty ? setLeave(true) : router.push('/studio/npcs'))}
            >
              {t('Назад')}
            </Button>
            <Button busy={busy} type="submit">
              <Save size={16} />
              {t('Сохранить NPC')}
            </Button>
          </div>
        </fieldset>
      </form>
      {!isNew && !dirty && (
        <details className={styles.artwork}>
          <summary>
            <ImagePlus size={19} />
            {text('artwork')}
          </summary>
          <CharacterSpriteControl target={{ kind: 'npc', id }} onSaved={resource.reload} />
        </details>
      )}
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
    </section>
  );
}

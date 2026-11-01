'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { npcSchema, type Adventure, type ModelProfile, type Npc } from '@dreamwalk/contracts';
import { api, ApiError, assetUrl, errorMessage, useResource } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Button, ErrorBox, Field, Input, Modal, Panel, Select, Textarea, UploadField } from '../ui';
import { CharacterSpriteControl } from '../visual-authoring/character-sprite-control';

const messages = {
  continue: ['Продолжить редактирование', 'Continue editing', 'Продовжити редагування'],
  title: ['Персонажи этой истории', 'Characters in this story', 'Персонажі цієї історії'],
  intro: [
    'Изменения здесь не меняют библиотечные шаблоны или другие истории.',
    'Edits here never change library templates or other stories.',
    'Зміни тут не змінюють бібліотечні шаблони чи інші історії.',
  ],
  create: ['Создать NPC здесь', 'Create NPC here', 'Створити NPC тут'],
  edit: ['Редактировать', 'Edit', 'Редагувати'],
  copy: [
    'Скопировать в историю и редактировать',
    'Copy into story and edit',
    'Скопіювати в історію й редагувати',
  ],
  library: [
    'Необязательный шаблон из библиотеки',
    'Optional library template',
    'Необов’язковий шаблон із бібліотеки',
  ],
  choose: ['Выберите шаблон', 'Choose a template', 'Виберіть шаблон'],
  import: ['Добавить копию', 'Add a copy', 'Додати копію'],
  save: ['Сохранить персонажа', 'Save character', 'Зберегти персонажа'],
  saved: [
    'Персонаж сохранён в этой истории.',
    'Character saved in this story.',
    'Персонажа збережено в цій історії.',
  ],
  export: [
    'Сохранить отдельным шаблоном',
    'Save a separate library template',
    'Зберегти окремим шаблоном',
  ],
  exported: [
    'Отдельный шаблон сохранён в библиотеке.',
    'A separate template was saved in your library.',
    'Окремий шаблон збережено в бібліотеці.',
  ],
  dirty: [
    'Сначала сохраните изменения, чтобы подготовить образ или библиотечный шаблон.',
    'Save changes before preparing appearance or a library template.',
    'Спочатку збережіть зміни, щоб підготувати образ чи бібліотечний шаблон.',
  ],
  discard: ['Закрыть без сохранения?', 'Close without saving?', 'Закрити без збереження?'],
  discardInfo: [
    'Несохранённые изменения персонажа будут потеряны.',
    'Unsaved character changes will be lost.',
    'Незбережені зміни персонажа буде втрачено.',
  ],
  empty: [
    'Добавьте нового персонажа или скопируйте шаблон.',
    'Create a character or copy a template.',
    'Створіть персонажа або скопіюйте шаблон.',
  ],
  removed: [
    'Не выбран в истории; сохранение добавит его снова.',
    'Not selected in the story; saving adds this character again.',
    'Не вибрано в історії; збереження додасть його знову.',
  ],
} as const;
type LocalNpc = Npc & { storyId: string | null; sourceTemplateId: string | null };
type Draft = ReturnType<typeof npcSchema.parse>;
type MutationResult = { npc: LocalNpc; storyEditRevision: number };
const fields = [
  ['description', 'Публичное описание NPC', 4000],
  ['personality', 'Характер', 4000],
  ['appearance', 'Внешность', 4000],
  ['biography', 'Биография', 6000],
  ['secrets', 'Секреты и скрытые знания', 6000],
  ['greeting', 'Первая реплика', 2000],
] as const;
function draftFrom(npc: Npc): Draft {
  const {
    id: _id,
    createdAt: _created,
    updatedAt: _updated,
    editRevision: _revision,
    ...data
  } = npc;
  // A scoped DTO includes provenance, which is not author-editable schema data.
  return npcSchema.parse(
    Object.fromEntries(Object.entries(data).filter(([key]) => key in npcSchema.shape)),
  );
}
export function StoryNpcEditor({
  adventureId,
  beforeEdit,
  onChanged,
  selectedNpcIds,
}: {
  adventureId: string;
  beforeEdit: () => Promise<unknown>;
  onChanged: () => void;
  selectedNpcIds: string[];
}) {
  const { t, locale } = useT();
  const text = (key: keyof typeof messages) =>
    messages[key][locale === 'ru' ? 0 : locale === 'en' ? 1 : 2];
  const base = `/studio/adventures/${adventureId}/npcs`;
  const locals = useResource<{ npcs: LocalNpc[]; storyEditRevision: number }>(base);
  const templates = useResource<Npc[]>('/npcs');
  const models = useResource<ModelProfile[]>('/models');
  const [editing, setEditing] = useState<LocalNpc | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(() => ({
    ...npcSchema.parse({ name: 'New NPC', sourceLanguage: locale }),
    name: '',
  }));
  const [baseline, setBaseline] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [discard, setDiscard] = useState(false);
  const epoch = useRef(0),
    lock = useRef(false),
    editingRef = useRef(editing);
  editingRef.current = editing;
  const operations = useRef(new Map<string, { path: string; method: string; body: object }>());
  const dirty = !!editing && JSON.stringify(draft) !== baseline;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    epoch.current++;
    operations.current.clear();
    setEditing(null);
    setError('');
    setNotice('');
    return () => {
      epoch.current++;
    };
  }, [adventureId]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const open = (npc: LocalNpc | 'new') => {
    if (lock.current || dirty) return;
    epoch.current++;
    const next =
      npc === 'new'
        ? { ...npcSchema.parse({ name: 'New NPC', sourceLanguage: locale }), name: '' }
        : draftFrom(npc);
    setEditing(npc);
    setDraft(next);
    setBaseline(JSON.stringify(next));
    setError('');
    setNotice('');
  };
  const close = () => {
    if (lock.current) return;
    epoch.current++;
    setEditing(null);
    setDiscard(false);
    setError('');
  };
  const formEpoch = epoch.current;
  const change = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    dirtyRef.current = true;
    setDraft((old) => ({ ...old, [key]: value }));
  };
  async function mutate(kind: 'save' | 'import' | 'export', importId?: string) {
    if (lock.current) return;
    const current = editing;
    if (kind !== 'import' && !current) return;
    const intent =
      kind === 'import'
        ? { templateId: importId }
        : kind === 'export'
          ? { expectedNpcRevision: current === 'new' ? 0 : current!.editRevision }
          : current === 'new'
            ? { npc: draft }
            : { expectedNpcRevision: current!.editRevision, patch: draft };
    const path =
      kind === 'import'
        ? `${base}/import`
        : kind === 'export'
          ? `${base}/${(current as LocalNpc).id}/template`
          : current === 'new'
            ? base
            : `${base}/${(current as LocalNpc).id}`;
    const method = kind === 'save' && current !== 'new' ? 'PATCH' : 'POST';
    const key = JSON.stringify({ path, method, intent });
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const stamp = epoch.current;
    try {
      if (kind === 'save') npcSchema.parse(draft);
      await beforeEdit();
      if (stamp !== epoch.current) return;
      let operation = operations.current.get(key);
      if (!operation) {
        const story = await api<Adventure>(`/studio/adventures/${adventureId}`);
        if (stamp !== epoch.current) return;
        operation = {
          path,
          method,
          body: {
            ...intent,
            requestId: crypto.randomUUID(),
            expectedStoryRevision: story.editRevision,
          },
        };
        operations.current.set(key, operation);
      }
      const result = await api<MutationResult>(operation.path, {
        method: operation.method,
        body: JSON.stringify(operation.body),
      });
      if (stamp !== epoch.current) return;
      locals.reload();
      templates.reload();
      onChanged();
      if (kind !== 'export') {
        const next = draftFrom(result.npc);
        setEditing(result.npc);
        setDraft(next);
        setBaseline(JSON.stringify(next));
      }
      setNotice(text(kind === 'export' ? 'exported' : 'saved'));
    } catch (failure) {
      if (stamp === epoch.current) {
        if (
          failure instanceof ApiError &&
          ['STALE_STATE', 'VALIDATION_FAILED', 'NOT_FOUND', 'IDEMPOTENCY_CONFLICT'].includes(
            failure.code,
          )
        ) {
          operations.current.delete(key);
          locals.reload();
        }
        setError(errorMessage(failure));
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void mutate('save');
  }
  const existing = locals.data?.npcs ?? [];
  const legacy = templates.data?.filter((npc) => selectedNpcIds.includes(npc.id)) ?? [];
  return (
    <Panel className="stack">
      <h2 data-testid="story-npc-editor">{text('title')}</h2>
      <p className="muted">{text('intro')}</p>
      <ErrorBox
        message={locals.error || templates.error}
        retry={() => {
          locals.reload();
          templates.reload();
        }}
      />
      {!editing && (
        <>
          {!existing.length && !legacy.length && <p>{text('empty')}</p>}
          {existing.map((npc) => (
            <div className="row" key={npc.id}>
              <strong>{npc.name}</strong>
              {!selectedNpcIds.includes(npc.id) && <small>{text('removed')}</small>}
              <Button type="button" disabled={busy} onClick={() => open(npc)}>
                {text('edit')}
              </Button>
            </div>
          ))}
          {legacy.map((npc) => (
            <div className="row" key={npc.id}>
              <strong>{npc.name}</strong>
              <Button type="button" disabled={busy} onClick={() => void mutate('import', npc.id)}>
                {text('copy')}
              </Button>
            </div>
          ))}
          <Button type="button" disabled={busy} onClick={() => open('new')}>
            {text('create')}
          </Button>
          <Field label={text('library')}>
            <Select
              value={templateId}
              disabled={busy}
              onChange={(event) => setTemplateId(event.target.value)}
            >
              <option value="">{text('choose')}</option>
              {templates.data?.map((npc) => (
                <option key={npc.id} value={npc.id}>
                  {npc.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            type="button"
            disabled={!templateId || busy}
            onClick={() => void mutate('import', templateId)}
          >
            {text('import')}
          </Button>
        </>
      )}
      {editing && (
        <>
          <form onSubmit={submit} className="stack">
            <fieldset disabled={busy} className="stack">
              <Field label={t('Язык оригинала')}>
                <Select
                  value={draft.sourceLanguage}
                  onChange={(event) =>
                    change('sourceLanguage', event.target.value as Draft['sourceLanguage'])
                  }
                >
                  <option value="ru">Русский</option>
                  <option value="en">English</option>
                  <option value="uk">Українська</option>
                </Select>
              </Field>
              <Field label={t('Имя NPC')}>
                <Input
                  required
                  minLength={2}
                  maxLength={80}
                  value={draft.name}
                  onChange={(event) => change('name', event.target.value)}
                />
              </Field>
              <Field label={t('Возраст')} hint={t('Персонажи этой платформы — совершеннолетние.')}>
                <Input
                  type="number"
                  required
                  min={18}
                  max={10000}
                  value={draft.age}
                  onChange={(event) => change('age', Number(event.target.value))}
                />
              </Field>
              <Field label={t('Роль в мире')}>
                <Input
                  maxLength={120}
                  value={draft.role}
                  onChange={(event) => change('role', event.target.value)}
                />
              </Field>
              {fields.map(([key, label, limit]) => (
                <Field key={key} label={t(label)}>
                  <Textarea
                    maxLength={limit}
                    value={draft[key]}
                    onChange={(event) => change(key, event.target.value)}
                  />
                </Field>
              ))}
              <Field label={t('Стиль поведения')}>
                <Select
                  value={draft.modelProfileId ?? ''}
                  onChange={(event) => change('modelProfileId', event.target.value || null)}
                >
                  <option value="">{t('Без предпочтения')}</option>
                  {models.data
                    ?.filter((model) => model.enabled)
                    .map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                      </option>
                    ))}
                </Select>
              </Field>
              <ErrorBox message={models.error} retry={models.reload} />
              <UploadField
                label={t('Загрузить портрет')}
                onUploaded={(asset) => {
                  if (formEpoch === epoch.current && !lock.current)
                    change('portraitAssetId', asset.id);
                }}
              />
              {draft.portraitAssetId && (
                <div className="row">
                  <img
                    src={assetUrl(draft.portraitAssetId)}
                    alt={t('Портрет NPC')}
                    width={80}
                    height={80}
                  />
                  <Button type="button" onClick={() => change('portraitAssetId', null)}>
                    {t('Убрать портрет')}
                  </Button>
                </div>
              )}
              <div className="row">
                <Button type="submit" busy={busy}>
                  {text('save')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => (dirty ? setDiscard(true) : close())}
                >
                  {t('Закрыть')}
                </Button>
              </div>
            </fieldset>
          </form>
          {editing !== 'new' && !dirty && !busy ? (
            <>
              <Button type="button" onClick={() => void mutate('export')}>
                {text('export')}
              </Button>
              <CharacterSpriteControl
                key={`${editing.id}:${editing.editRevision}`}
                target={{ kind: 'npc', id: editing.id }}
                onSaved={() => {
                  const id = editing.id,
                    stamp = epoch.current;
                  void api<{ npcs: LocalNpc[] }>(base)
                    .then((result) => {
                      if (
                        stamp !== epoch.current ||
                        dirtyRef.current ||
                        editingRef.current === 'new' ||
                        editingRef.current?.id !== id
                      )
                        return;
                      const saved = result.npcs.find((npc) => npc.id === id);
                      if (saved) {
                        const next = draftFrom(saved);
                        setEditing(saved);
                        setDraft(next);
                        setBaseline(JSON.stringify(next));
                      }
                      locals.reload();
                      onChanged();
                    })
                    .catch((failure) => {
                      if (stamp === epoch.current) setError(errorMessage(failure));
                    });
                }}
              />
            </>
          ) : (
            <p className="muted">{text('dirty')}</p>
          )}
        </>
      )}
      <ErrorBox message={error} />
      {notice && <p role="status">{notice}</p>}
      {discard && (
        <Modal title={text('discard')} onClose={() => setDiscard(false)}>
          <p>{text('discardInfo')}</p>
          <Button type="button" onClick={() => setDiscard(false)}>
            {text('continue')}
          </Button>
          <Button type="button" variant="danger" onClick={close}>
            {t('Закрыть')}
          </Button>
        </Modal>
      )}
    </Panel>
  );
}

'use client';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, errorMessage } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Button, ErrorBox, Field, Select } from '../ui';

type Settings = {
  detail: 'concise' | 'balanced' | 'descriptive';
  formOfAddress: 'character' | 'she' | 'he' | 'they';
  dialogueFormat: 'natural' | 'quoted';
};
type Snapshot = { revision: number; settings: Settings };
const copy = {
  title: ['Подача повествования', 'Narrative presentation', 'Подання оповіді'],
  help: [
    'Настройки действуют для ваших следующих запросов. Они не меняют характер NPC, прошлые события, инвентарь или баланс.',
    'These preferences apply to your future requests. They do not change NPC personality, past events, inventory or balance.',
    'Налаштування діють для ваших наступних запитів. Вони не змінюють характер NPC, минулі події, інвентар чи баланс.',
  ],
  detail: ['Подробность описаний', 'Description detail', 'Докладність описів'],
  concise: ['Кратко', 'Concise', 'Стисло'],
  balanced: ['Умеренно', 'Balanced', 'Помірно'],
  descriptive: ['Подробно', 'Descriptive', 'Докладно'],
  address: [
    'Как обращаться к вашему герою',
    'How to refer to your hero',
    'Як звертатися до вашого героя',
  ],
  character: ['По имени героя', 'Use the hero’s name', 'На ім’я героя'],
  she: ['Она', 'She / her', 'Вона'],
  he: ['Он', 'He / him', 'Він'],
  they: ['Они', 'They / them', 'Вони'],
  format: ['Оформление прямой речи', 'Dialogue formatting', 'Оформлення прямої мови'],
  natural: ['Обычный текст', 'Natural prose', 'Звичайний текст'],
  quoted: ['Реплики в кавычках', 'Quoted dialogue', 'Репліки в лапках'],
  save: ['Сохранить подачу', 'Save presentation', 'Зберегти подання'],
  cancel: ['Отменить изменения', 'Discard changes', 'Скасувати зміни'],
  saved: [
    'Настройки сохранены для следующих запросов.',
    'Preferences saved for future requests.',
    'Налаштування збережено для наступних запитів.',
  ],
  reload: [
    'Загрузить серверную версию и отменить мои правки',
    'Load the server version and discard my edits',
    'Завантажити серверну версію та скасувати мої правки',
  ],
  stale: [
    'Настройки изменились в другой вкладке. Сверьте серверную версию перед сохранением.',
    'Preferences changed in another tab. Reload the server version before saving.',
    'Налаштування змінилися в іншій вкладці. Завантажте серверну версію перед збереженням.',
  ],
  pending: [
    'Ответ сервера не получен: настройки могли сохраниться. Повторите сохранение, чтобы подтвердить результат; до этого изменение и отмена недоступны.',
    'The server response was lost: preferences may have been saved. Retry the same save to confirm the result; editing and discarding are unavailable until then.',
    'Відповідь сервера не отримано: налаштування могли зберегтися. Повторіть збереження, щоб підтвердити результат; доти зміна та скасування недоступні.',
  ],
  retry: ['Повторить загрузку', 'Retry loading', 'Повторити завантаження'],
  loading: ['Загрузка настроек…', 'Loading preferences…', 'Завантаження налаштувань…'],
} as const;
export function NarrativePreferences({
  campaignId,
  disabled = false,
}: {
  campaignId: string;
  disabled?: boolean;
}) {
  const { locale } = useT();
  const text = (key: keyof typeof copy) => copy[key][locale === 'ru' ? 0 : locale === 'en' ? 1 : 2];
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [stale, setStale] = useState(false),
    [notice, setNotice] = useState(false);
  const [pending, setPending] = useState(false);
  const [reload, setReload] = useState(0);
  const lock = useRef(false),
    epoch = useRef(0);
  const operations = useRef(
    new Map<string, { operationId: string; expectedRevision: number; settings: Settings }>(),
  );
  const path = `/game/campaigns/${campaignId}/narrative-preferences`;
  useEffect(() => {
    epoch.current++;
    operations.current.clear();
    setSaved(null);
    setDraft(null);
    setStale(false);
    setError('');
    setNotice(false);
    setPending(false);
    return () => {
      epoch.current++;
    };
  }, [campaignId]);
  useEffect(() => {
    if (!open || saved) return;
    const stamp = epoch.current;
    let active = true;
    setBusy(true);
    setError('');
    void api<Snapshot>(path)
      .then((result) => {
        if (!active || stamp !== epoch.current) return;
        setSaved(result);
        setDraft(result.settings);
        setStale(false);
      })
      .catch((failure) => {
        if (active && stamp === epoch.current) setError(errorMessage(failure));
      })
      .finally(() => {
        if (active && stamp === epoch.current) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [open, saved, path, reload]);
  const dirty = !!saved && !!draft && JSON.stringify(saved.settings) !== JSON.stringify(draft);
  const change = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    if (pending) return;
    setDraft((old) => (old ? { ...old, [key]: value } : old));
    setNotice(false);
  };
  async function save() {
    if (lock.current || disabled || !draft || !saved || stale) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice(false);
    const stamp = epoch.current;
    const key = JSON.stringify({ revision: saved.revision, settings: draft });
    let operation = operations.current.get(key);
    if (!operation) {
      operation = {
        operationId: crypto.randomUUID(),
        expectedRevision: saved.revision,
        settings: draft,
      };
      operations.current.set(key, operation);
    }
    try {
      const result = await api<Snapshot>(path, { method: 'POST', body: JSON.stringify(operation) });
      if (stamp !== epoch.current) return;
      operations.current.clear();
      setPending(false);
      setSaved(result);
      setDraft(result.settings);
      setNotice(true);
      window.dispatchEvent(
        new CustomEvent('dreamwalk:narrative-preferences-updated', {
          detail: { campaignId, revision: result.revision },
        }),
      );
    } catch (failure) {
      if (stamp !== epoch.current) return;
      if (
        failure instanceof ApiError &&
        [
          'STALE_STATE',
          'VALIDATION_FAILED',
          'IDEMPOTENCY_CONFLICT',
          'FORBIDDEN',
          'NOT_FOUND',
          'RATE_LIMITED',
        ].includes(failure.code)
      ) {
        setPending(false);
        operations.current.delete(key);
        if (failure.code === 'STALE_STATE') setStale(true);
      } else {
        setPending(true);
      }
      setError(errorMessage(failure));
    } finally {
      lock.current = false;
      if (stamp === epoch.current) setBusy(false);
    }
  }
  return (
    <details
      onToggle={(event) => setOpen(event.currentTarget.open)}
      data-testid="narrative-preferences"
    >
      <summary>{text('title')}</summary>
      {open && (
        <div className="stack">
          <p className="muted">{text('help')}</p>
          {!saved && busy && <p role="status">{text('loading')}</p>}
          {draft && (
            <fieldset disabled={busy || disabled} className="stack">
              <Field label={text('detail')}>
                <Select
                  disabled={pending}
                  aria-label={text('detail')}
                  value={draft.detail}
                  onChange={(event) => change('detail', event.target.value as Settings['detail'])}
                >
                  {(['concise', 'balanced', 'descriptive'] as const).map((value) => (
                    <option key={value} value={value}>
                      {text(value)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={text('address')}>
                <Select
                  disabled={pending}
                  aria-label={text('address')}
                  value={draft.formOfAddress}
                  onChange={(event) =>
                    change('formOfAddress', event.target.value as Settings['formOfAddress'])
                  }
                >
                  {(['character', 'she', 'he', 'they'] as const).map((value) => (
                    <option key={value} value={value}>
                      {text(value)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={text('format')}>
                <Select
                  disabled={pending}
                  aria-label={text('format')}
                  value={draft.dialogueFormat}
                  onChange={(event) =>
                    change('dialogueFormat', event.target.value as Settings['dialogueFormat'])
                  }
                >
                  {(['natural', 'quoted'] as const).map((value) => (
                    <option key={value} value={value}>
                      {text(value)}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="row">
                <Button
                  type="button"
                  disabled={!dirty || stale}
                  busy={busy}
                  onClick={() => void save()}
                >
                  {text('save')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={!dirty || pending}
                  onClick={() => {
                    if (pending) return;
                    setDraft(saved?.settings ?? null);
                    setNotice(false);
                  }}
                >
                  {text('cancel')}
                </Button>
              </div>
            </fieldset>
          )}
          {pending && <p role="status">{text('pending')}</p>}
          {stale && (
            <>
              <p role="alert">{text('stale')}</p>
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  operations.current.clear();
                  setSaved(null);
                  setDraft(null);
                  setError('');
                  setReload((value) => value + 1);
                }}
              >
                {text('reload')}
              </Button>
            </>
          )}
          <ErrorBox
            message={error}
            retry={!saved && !busy ? () => setReload((value) => value + 1) : undefined}
          />
          {notice && <p role="status">{text('saved')}</p>}
        </div>
      )}
    </details>
  );
}

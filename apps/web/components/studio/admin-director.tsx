'use client';
import { useState, type FormEvent } from 'react';
import {
  DIRECTOR_STYLE_PRESETS,
  type DirectorCatalog,
  type DirectorProfile,
  type DirectorStyle,
} from '@dreamwalk/contracts/dist/director-style';
import { api, ApiError, errorMessage, useClient, useResource } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { directorProfileName } from '../game/director-selection';
import { Button, ErrorBox, Field, Input, Loading, Panel, Select, Textarea } from '../ui';

export function AdminDirector() {
  const { t } = useT();
  const catalog = useResource<DirectorCatalog>('/admin/directors');
  return (
    <Panel>
      <h2>{t('ИИ-ведущие')}</h2>
      <p className="muted">
        {t(
          'Создай ведущих с разной подачей. Игрок выбирает ведущего для своего прохождения и может сменить его позже.',
        )}
      </p>
      <ErrorBox message={catalog.error} retry={catalog.reload} />
      {catalog.loading ? (
        <Loading />
      ) : (
        catalog.data && (
          <DirectorForm
            key={catalog.data.revision}
            initial={catalog.data}
            reload={catalog.reload}
          />
        )
      )}
    </Panel>
  );
}
function DirectorForm({ initial, reload }: { initial: DirectorCatalog; reload: () => void }) {
  const { t } = useT();
  const { toast } = useClient();
  const [profiles, setProfiles] = useState<DirectorProfile[]>(initial.profiles);
  const [defaultProfileId, setDefaultProfileId] = useState(initial.defaultProfileId);
  const [editingId, setEditingId] = useState(initial.defaultProfileId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const draft = profiles.find((profile) => profile.id === editingId)!;
  const selected =
    Object.entries(DIRECTOR_STYLE_PRESETS).find(
      ([, preset]) =>
        preset.style === draft.style &&
        preset.pacing === draft.pacing &&
        preset.initiative === draft.initiative,
    )?.[0] ?? 'custom';
  const changed =
    defaultProfileId !== initial.defaultProfileId ||
    JSON.stringify(profiles) !== JSON.stringify(initial.profiles);
  const valid =
    profiles.every((profile) => profile.name.trim().length > 0) &&
    profiles.some((profile) => profile.id === defaultProfileId && profile.enabled);
  function edit(patch: Partial<DirectorProfile>) {
    setProfiles((current) =>
      current.map((profile) => (profile.id === editingId ? { ...profile, ...patch } : profile)),
    );
  }
  function add() {
    const id = crypto.randomUUID();
    setProfiles((current) => [
      ...current,
      {
        id,
        name: t('Новый ведущий'),
        description: '',
        enabled: true,
        ...DIRECTOR_STYLE_PRESETS.coauthor,
      },
    ]);
    setEditingId(id);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError('');
    try {
      await api('/admin/directors', {
        method: 'PATCH',
        body: JSON.stringify({
          expectedRevision: initial.revision,
          defaultProfileId,
          profiles: profiles.map((profile) => ({
            ...profile,
            name: profile.name.trim(),
            description: profile.description.trim(),
          })),
        }),
      });
      toast(t('Ведущие сохранены'));
      reload();
    } catch (error) {
      setError(
        error instanceof ApiError && error.code === 'DIRECTOR_STYLE_STALE'
          ? t('DIRECTOR_CATALOG_STALE')
          : errorMessage(error),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="stack"
      onSubmit={(event) => void save(event)}
      data-testid="director-catalog"
      style={{ minWidth: 0 }}
    >
      <Field label={t('Ведущий для настройки')}>
        <Select
          value={editingId}
          disabled={busy}
          onChange={(event) => setEditingId(event.target.value)}
        >
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {directorProfileName(profile, t)}
              {!profile.enabled ? ` · ${t('В архиве')}` : ''}
              {profile.id === defaultProfileId ? ` · ${t('По умолчанию')}` : ''}
            </option>
          ))}
        </Select>
      </Field>
      <div className="form-actions">
        <Button
          type="button"
          variant="secondary"
          disabled={busy || profiles.length >= 24}
          onClick={add}
        >
          {t('Добавить ведущего')}
        </Button>
        <small>{profiles.length} / 24</small>
      </div>
      <Field label={t('Название ведущего')}>
        <Input
          required
          maxLength={80}
          value={draft.name}
          disabled={busy}
          onChange={(event) => edit({ name: event.target.value })}
        />
      </Field>
      <Field
        label={t('Описание для игроков')}
        hint={t('Короткое описание для выбора. Это не инструкция для ИИ.')}
      >
        <Textarea
          rows={2}
          maxLength={300}
          value={draft.description}
          disabled={busy}
          onChange={(event) => edit({ description: event.target.value })}
        />
      </Field>
      <div className="form-actions">
        <label>
          <input
            type="checkbox"
            checked={draft.enabled}
            disabled={busy || draft.id === defaultProfileId}
            onChange={(event) => edit({ enabled: event.target.checked })}
          />{' '}
          {t('Доступен игрокам')}
        </label>
        <label>
          <input
            type="checkbox"
            checked={draft.id === defaultProfileId}
            disabled={busy || !draft.enabled || draft.id === defaultProfileId}
            onChange={() => setDefaultProfileId(draft.id)}
          />{' '}
          {t('По умолчанию')}
        </label>
      </div>
      <small className="muted">
        {t(
          'Скрытый ведущий остаётся в существующих прохождениях. Чтобы скрыть ведущего по умолчанию, сначала выбери другого.',
        )}
      </small>
      <Field label={t('Тип ведущего')}>
        <Select
          value={selected}
          disabled={busy}
          onChange={(event) => {
            const preset =
              DIRECTOR_STYLE_PRESETS[event.target.value as keyof typeof DIRECTOR_STYLE_PRESETS];
            if (preset) edit(preset);
          }}
        >
          <option value="coauthor">{t('Соавтор — сбалансированный')}</option>
          <option value="storyteller">{t('Рассказчик — неспешный')}</option>
          <option value="director">{t('Режиссёр — инициативный')}</option>
          <option value="custom" disabled>
            {t('Свой вариант')}
          </option>
        </Select>
      </Field>
      <details>
        <summary>{t('Настроить подачу')}</summary>
        <div className="stack">
          <Field label={t('Манера повествования')}>
            <Select
              value={draft.style}
              disabled={busy}
              onChange={(event) => edit({ style: event.target.value as DirectorStyle['style'] })}
            >
              <option value="natural">{t('Естественная')}</option>
              <option value="cinematic">{t('Кинематографичная')}</option>
              <option value="atmospheric">{t('Атмосферная')}</option>
            </Select>
          </Field>
          <Field label={t('Темп истории')}>
            <Select
              value={draft.pacing}
              disabled={busy}
              onChange={(event) => edit({ pacing: event.target.value as DirectorStyle['pacing'] })}
            >
              <option value="deliberate">{t('Неспешный')}</option>
              <option value="balanced">{t('Размеренный')}</option>
              <option value="brisk">{t('Динамичный')}</option>
            </Select>
          </Field>
          <Field label={t('Инициатива ведущего')}>
            <Select
              value={draft.initiative}
              disabled={busy}
              onChange={(event) =>
                edit({ initiative: event.target.value as DirectorStyle['initiative'] })
              }
            >
              <option value="reactive">{t('Следует за игроком')}</option>
              <option value="balanced">{t('Предлагает зацепки по ситуации')}</option>
              <option value="proactive">{t('Активно предлагает зацепки')}</option>
            </Select>
          </Field>
        </div>
      </details>
      <p className="muted">
        {t(
          'Ведущий не решает за игрока, не раскрывает тайны и не обходит правила действий. Инициатива не запускает дополнительные генерации. Уже подготовленные ответы сохраняют прежний стиль.',
        )}
      </p>
      <ErrorBox message={error} />
      {error && (
        <Button type="button" variant="secondary" disabled={busy} onClick={reload}>
          {t('Обновить настройки')}
        </Button>
      )}
      <div className="form-actions">
        <Button type="submit" busy={busy} disabled={!changed || !valid}>
          {t('Сохранить ведущих')}
        </Button>
      </div>
    </form>
  );
}

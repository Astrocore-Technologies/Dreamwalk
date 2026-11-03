'use client';
import { useState, type FormEvent } from 'react';
import {
  DIRECTOR_STYLE_PRESETS,
  type DirectorStyle,
  type DirectorStyleSettings,
} from '@dreamwalk/contracts/dist/director-style';
import { api, ApiError, errorMessage, useClient, useResource } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Button, ErrorBox, Field, Loading, Panel, Select } from '../ui';

export function AdminDirector() {
  const { t } = useT();
  const settings = useResource<DirectorStyleSettings>('/admin/director-style');
  return (
    <Panel>
      <h2>{t('ИИ-ведущий')}</h2>
      <p className="muted">
        {t(
          'Общий стиль новых обращений к ведущему. Обычный РП остаётся свободным, личность NPC не меняется.',
        )}
      </p>
      <ErrorBox message={settings.error} retry={settings.reload} />
      {settings.loading ? (
        <Loading />
      ) : (
        settings.data && (
          <DirectorForm
            key={settings.data.revision}
            initial={settings.data}
            reload={settings.reload}
          />
        )
      )}
    </Panel>
  );
}
function DirectorForm({ initial, reload }: { initial: DirectorStyleSettings; reload: () => void }) {
  const { t } = useT(),
    { toast } = useClient();
  const [draft, setDraft] = useState<DirectorStyle>({
    style: initial.style,
    pacing: initial.pacing,
    initiative: initial.initiative,
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const selected =
    Object.entries(DIRECTOR_STYLE_PRESETS).find(
      ([, preset]) =>
        preset.style === draft.style &&
        preset.pacing === draft.pacing &&
        preset.initiative === draft.initiative,
    )?.[0] ?? 'custom';
  const changed =
    draft.style !== initial.style ||
    draft.pacing !== initial.pacing ||
    draft.initiative !== initial.initiative;
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/admin/director-style', {
        method: 'PATCH',
        body: JSON.stringify({ ...draft, expectedRevision: initial.revision }),
      });
      toast(t('Стиль ведущего сохранён'));
      reload();
    } catch (error) {
      setError(
        error instanceof ApiError && error.code === 'DIRECTOR_STYLE_STALE'
          ? t('DIRECTOR_STYLE_STALE')
          : t(errorMessage(error)),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="stack" onSubmit={(event) => void save(event)}>
      <Field label={t('Тип ведущего')}>
        <Select
          value={selected}
          disabled={busy}
          onChange={(event) => {
            const preset =
              DIRECTOR_STYLE_PRESETS[event.target.value as keyof typeof DIRECTOR_STYLE_PRESETS];
            if (preset) setDraft({ ...preset });
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
              onChange={(event) =>
                setDraft({ ...draft, style: event.target.value as DirectorStyle['style'] })
              }
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
              onChange={(event) =>
                setDraft({ ...draft, pacing: event.target.value as DirectorStyle['pacing'] })
              }
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
                setDraft({
                  ...draft,
                  initiative: event.target.value as DirectorStyle['initiative'],
                })
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
        <Button type="submit" busy={busy} disabled={!changed}>
          {t('Сохранить стиль')}
        </Button>
      </div>
    </form>
  );
}

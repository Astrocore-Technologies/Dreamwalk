'use client';
import { useEffect, useRef, useState } from 'react';
import type {
  CampaignDirectorSelection,
  DirectorCatalog,
  DirectorProfile,
} from '@dreamwalk/contracts/dist/director-style';
import { api, ApiError, errorMessage, useClient, useResource } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Button, ErrorBox, Field, Select } from '@/components/ui';

const defaultNames: Record<string, string> = {
  coauthor: 'Соавтор',
  storyteller: 'Рассказчик',
  director: 'Режиссёр',
};
export function directorProfileName(
  profile: Pick<DirectorProfile, 'id' | 'name'>,
  t: (key: string) => string,
) {
  return defaultNames[profile.id] === profile.name ? t(profile.name) : profile.name;
}

/** The choice is local to this story visit, including a sign-in/hero detour. It is not launch consent. */
export function useDirectorSelection(scope: string, preparationKey?: string) {
  const resource = useResource<DirectorCatalog>('/game/directors');
  const storageKey = `dreamwalk-director-choice:${scope}`;
  const identity = `${storageKey}:${preparationKey || ''}`;
  const [choice, setChoice] = useState<{
    key: string;
    id: string;
    pinnedId: string;
    legacy: boolean;
  } | null>(null);
  useEffect(() => {
    const pinnedId = preparationKey
      ? sessionStorage.getItem(preparationKey + ':director') || ''
      : '';
    const legacy = !!(
      preparationKey &&
      !pinnedId &&
      (sessionStorage.getItem(preparationKey + ':prepare') ||
        sessionStorage.getItem(preparationKey + ':dispatch-pending'))
    );
    setChoice({
      key: identity,
      id: sessionStorage.getItem(storageKey) || '',
      pinnedId: pinnedId || (legacy ? 'coauthor' : ''),
      legacy,
    });
  }, [identity, storageKey, preparationKey]);
  const hydrated = choice?.key === identity;
  const profileId = hydrated
    ? choice.pinnedId || choice.id || resource.data?.defaultProfileId || ''
    : '';
  const profile = resource.data?.profiles.find((entry) => entry.id === profileId && entry.enabled);
  return {
    resource,
    profileId,
    profile,
    hydrated,
    locked: hydrated && !!choice.pinnedId,
    legacy: hydrated && choice.legacy,
    ready: hydrated && !resource.loading && !resource.error && !!profile,
    lock: () => {
      if (!choice || !hydrated || !profileId || !preparationKey || choice.pinnedId) return;
      sessionStorage.setItem(preparationKey + ':director', profileId);
      setChoice({ ...choice, pinnedId: profileId });
    },
    releaseCompleted: () => {
      // Called only after an authenticated read confirms this preparation has a campaign.
      // Forget the finished local launch identity, never the campaign or financial records.
      if (!choice || !hydrated || !preparationKey) return;
      sessionStorage.removeItem(preparationKey + ':director');
      setChoice({ ...choice, pinnedId: '', legacy: false });
    },
    unlock: () => {
      if (!choice || !hydrated || !preparationKey || choice.legacy) return;
      sessionStorage.removeItem(preparationKey + ':director');
      setChoice({ ...choice, pinnedId: '' });
    },
    setProfileId: (id: string) => {
      if (!choice || !hydrated || choice.pinnedId) return;
      sessionStorage.setItem(storageKey, id);
      setChoice({ ...choice, id });
    },
  };
}

export function DirectorSelection({
  selection,
  disabled = false,
  pinnedProfileId,
  locked = false,
}: {
  selection: ReturnType<typeof useDirectorSelection>;
  disabled?: boolean;
  pinnedProfileId?: string;
  locked?: boolean;
}) {
  const { t } = useT();
  const profileId = pinnedProfileId || selection.profileId;
  const profile = selection.resource.data?.profiles.find((entry) => entry.id === profileId);
  return (
    <div
      className="stack"
      data-testid="director-selection"
      style={{ minWidth: 0, maxWidth: '100%', overflowWrap: 'anywhere' }}
    >
      <Field label={t('Ведущий для этого прохождения')}>
        <Select
          value={profileId}
          disabled={disabled || locked || !selection.hydrated || selection.resource.loading}
          onChange={(event) => selection.setProfileId(event.target.value)}
        >
          {!profileId && <option value="">{t('Выбери ведущего')}</option>}
          {profileId && !profile && (
            <option value={profileId}>
              {t(locked ? 'Ведущий сохранённой подготовки' : 'Выбранный ведущий недоступен')}
            </option>
          )}
          {selection.resource.data?.profiles
            .filter((entry) => entry.enabled)
            .map((entry) => (
              <option key={entry.id} value={entry.id}>
                {directorProfileName(entry, t)}
              </option>
            ))}
        </Select>
      </Field>
      {profile?.description && <small className="muted">{profile.description}</small>}
      {locked && (
        <small className="muted">
          {t('Выбор закреплён за подготовкой. Сменить ведущего можно в игре.')}
        </small>
      )}
      <ErrorBox
        message={
          selection.resource.error ||
          (!selection.resource.loading && selection.hydrated && !profile && !locked
            ? t('Выбранный ведущий недоступен. Выбери другого.')
            : '')
        }
        retry={selection.resource.reload}
      />
    </div>
  );
}

export function CampaignDirector({
  campaignId,
  disabled = false,
}: {
  campaignId: string;
  disabled?: boolean;
}) {
  const { t } = useT();
  const { toast } = useClient();
  const selection = useResource<CampaignDirectorSelection>(
    `/game/campaigns/${campaignId}/director`,
  );
  const catalog = useResource<DirectorCatalog>('/game/directors');
  const [profileId, setProfileId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const editing =
    !!selection.data?.canChange &&
    profileId !== selection.data.profileId &&
    !!catalog.data?.profiles.some((profile) => profile.id === profileId && profile.enabled);
  const refreshBlocked = useRef(false);
  refreshBlocked.current = busy || editing;
  useEffect(() => {
    if (selection.data) setProfileId(selection.data.profileId);
  }, [selection.data?.revision, selection.data?.profileId]);
  useEffect(() => {
    if (busy || editing) return;
    // Other members observe owner changes; refresh never launches a generation.
    // Do not disable an owner's save button between pointer down and pointer up.
    // The revision check still rejects changes made elsewhere while editing.
    const refresh = () => {
      if (!refreshBlocked.current && document.visibilityState === 'visible') selection.reload();
    };
    const timer = setInterval(refresh, 5000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [busy, editing, selection.reload]);
  async function change() {
    if (
      !selection.data?.canChange ||
      busy ||
      !catalog.data?.profiles.some((profile) => profile.id === profileId && profile.enabled)
    )
      return;
    setBusy(true);
    setError('');
    try {
      const result = await api<CampaignDirectorSelection>(
        `/game/campaigns/${campaignId}/director`,
        {
          method: 'POST',
          body: JSON.stringify({ profileId, expectedRevision: selection.data.revision }),
        },
      );
      selection.setData(result);
      toast(t('Ведущий изменён'));
    } catch (err) {
      const known =
        err instanceof ApiError &&
        ['DIRECTOR_STYLE_STALE', 'DIRECTOR_UNAVAILABLE'].includes(err.code);
      setError(
        known
          ? t(
              (err as ApiError).code === 'DIRECTOR_STYLE_STALE'
                ? 'DIRECTOR_SELECTION_STALE'
                : (err as ApiError).code,
            )
          : errorMessage(err),
      );
      selection.reload();
      catalog.reload();
    } finally {
      setBusy(false);
    }
  }
  const current = selection.data?.profile;
  const choices = catalog.data?.profiles.filter((profile) => profile.enabled) || [];
  return (
    <details data-testid="campaign-director" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
      <summary>
        {t('ИИ-ведущий')}
        {current ? ` · ${directorProfileName(current, t)}` : ''}
      </summary>
      <div className="stack">
        {current?.description && <p className="muted">{current.description}</p>}
        {selection.data?.canChange ? (
          <>
            <Field label={t('Ведущий для этого прохождения')}>
              <Select
                value={profileId}
                disabled={
                  disabled ||
                  busy ||
                  selection.loading ||
                  catalog.loading ||
                  !!catalog.error ||
                  !!selection.error
                }
                onChange={(event) => setProfileId(event.target.value)}
              >
                {current && !choices.some((profile) => profile.id === current.id) && (
                  <option value={current.id}>
                    {directorProfileName(current, t)} · {t('В архиве')}
                  </option>
                )}
                {choices.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {directorProfileName(profile, t)}
                  </option>
                ))}
              </Select>
            </Field>
            {choices.find((profile) => profile.id === profileId)?.description &&
              profileId !== current?.id && (
                <small>{choices.find((profile) => profile.id === profileId)?.description}</small>
              )}
            <Button
              type="button"
              variant="secondary"
              busy={busy}
              disabled={
                disabled ||
                selection.loading ||
                catalog.loading ||
                !!catalog.error ||
                !!selection.error ||
                !choices.some((profile) => profile.id === profileId) ||
                profileId === selection.data.profileId
              }
              onClick={() => void change()}
            >
              {t('Сменить ведущего')}
            </Button>
            <small>
              {t(
                'Выбор общий для участников этого прохождения. Изменение применяется к новым ответам и не запускает генерацию.',
              )}
            </small>
          </>
        ) : (
          selection.data && <p>{t('Ведущего меняет владелец прохождения')}</p>
        )}
        <ErrorBox
          message={error || selection.error || (selection.data?.canChange ? catalog.error : '')}
          retry={() => {
            selection.reload();
            catalog.reload();
          }}
        />
      </div>
    </details>
  );
}

'use client';
import { MapImageNotice } from './map-image-notice';
import { storyReturnPath, withStoryReturn } from '../story-return';
import { HeroSelection, useHeroSelection } from './hero-selection';
import { DirectorSelection, useDirectorSelection } from './director-selection';
import { useLaunchGate } from './use-launch-gate';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { CampaignSummary } from './use-game';
import { useEffect, useState } from 'react';
import { startState, type StartPreparation } from './start-state';
import { formatSparkSubunits } from '@dreamwalk/contracts';
import { providerSparkSubunits } from '../visual-authoring/spark-equivalent';
import { selectAdventureText, type Adventure } from '@dreamwalk/contracts';
import { api, ApiError, coverUrl, errorMessage, useClient, useResource } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Button, ErrorBox, Field, Modal, Select } from '@/components/ui';
export function AdventureLaunch({ adventure }: { adventure: Adventure }) {
  const { t, locale, taxonomy } = useT();
  const heroSelection = useHeroSelection();
  const router = useRouter();
  const { user, loading: authLoading } = useClient();
  const saves = useResource<{
    userId: string;
    adventureId: string;
    campaigns: CampaignSummary[];
  }>(user ? `/game/campaigns?adventureId=${encodeURIComponent(adventure.id)}` : null);
  const saveScope = `${user?.id}:${adventure.id}`;
  const [completedSave, setCompletedSave] = useState<{ scope: string; id: string } | null>(null);
  const [selectedSave, setSelectedSave] = useState('');
  const savesLoaded = saves.data?.userId === user?.id && saves.data?.adventureId === adventure.id;
  const savedCampaigns = user && savesLoaded ? saves.data!.campaigns : [];
  const completedId = completedSave?.scope === saveScope ? completedSave.id : null;
  const saveIds = savedCampaigns.map((campaign) => campaign.id);
  if (completedId && !saveIds.includes(completedId)) saveIds.unshift(completedId);
  const continueId = saveIds.includes(selectedSave) ? selectedSave : saveIds[0];
  const privateAccess =
    adventure.visibility === 'private' && ['owner', 'invited'].includes(adventure.access || '');
  const versions = useResource<{
    versions: {
      id: string;
      sourceRevision: number;
      audience: string;
      approved: boolean;
      createdAt: string;
    }[];
  }>(user && privateAccess ? `/game/adventures/${adventure.id}/playable-versions` : null);
  const versionId = privateAccess
    ? versions.data?.versions.find(
        (version) =>
          version.audience === 'private' &&
          version.approved &&
          version.id === adventure.playableVersionId,
      )?.id
    : adventure.playableVersionId;
  const baseStorageKey = `dreamwalk-start:${user?.id}:${versionId}:${heroSelection.heroId}`;
  const directorSelection = useDirectorSelection(`adventure:${adventure.id}`, baseStorageKey);
  const gate = useLaunchGate(
    `${user?.id}:${adventure.id}:${versionId}:${heroSelection.heroId}:${directorSelection.profileId}`,
  );
  type Quote = {
    imageInputCount?: number;
    schematicMapCount?: number;
    id: string;
    expiresAt: string;
    sparks?: { reserveSubunits: string; rateVersion?: string };
    estimatedTotalMicros?: number;
  };
  const [preparation, setPreparation] = useState<StartPreparation | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const estimatedSubunits = quote
    ? providerSparkSubunits(
        quote.estimatedTotalMicros,
        quote.sparks ? (quote.sparks.rateVersion ?? null) : undefined,
      )
    : null;
  const [confirm, setConfirm] = useState(false);
  const [dispatchUncertain, setDispatchUncertain] = useState(false);
  const [restoredKey, setRestoredKey] = useState('');
  const [restorationUncertain, setRestorationUncertain] = useState(false);
  // Consent to enter is local to this visit and selection, never restored from storage.
  const [entryKey, setEntryKey] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const storageKey = directorSelection.legacy
    ? baseStorageKey
    : `${baseStorageKey}:${directorSelection.profileId}`;
  useEffect(() => {
    setPreparation(null);
    setRestorationUncertain(false);
    setEntryKey('');
    setQuote(null);
    setConfirm(false);
    setDispatchUncertain(sessionStorage.getItem(storageKey + ':dispatch-pending') === 'yes');
    setError('');
    if (!sessionStorage.getItem(storageKey + ':prepare')) setRestoredKey(storageKey);
  }, [storageKey]);
  useEffect(() => {
    if (
      user &&
      versionId &&
      heroSelection.ready &&
      directorSelection.hydrated &&
      !busy &&
      restoredKey !== storageKey &&
      sessionStorage.getItem(storageKey + ':prepare')
    )
      void launch('restore');
  }, [storageKey, heroSelection.ready, directorSelection.hydrated, busy, restoredKey]);
  function operation(suffix: string) {
    const key = storageKey + ':' + suffix;
    let id = sessionStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem(key, id);
    }
    return id;
  }
  async function launch(
    action: 'prepare' | 'confirm' | 'refresh' | 'restart' | 'restore' | 'open' = 'prepare',
  ) {
    if (!user) {
      if (directorSelection.ready) directorSelection.setProfileId(directorSelection.profileId);
      router.push(
        withStoryReturn('/auth/sign-in', storyReturnPath(adventure.slug, heroSelection.heroId)),
      );
      return;
    }
    if (!versionId || !heroSelection.ready || !directorSelection.hydrated) return;
    if (['prepare', 'restart'].includes(action) && !directorSelection.ready && !preparation) return;
    if (action === 'restart' && !directorSelection.ready) return;
    const lease = gate.begin();
    if (!lease) return;
    const enterRequested = ['prepare', 'confirm', 'restart', 'open'].includes(action);
    if (enterRequested) setEntryKey(storageKey);
    const mayEnter = action !== 'restore' && (enterRequested || entryKey === storageKey);
    let navigating = false;
    setBusy(true);
    setError('');
    try {
      let current = preparation;
      if (action === 'refresh' && !current && sessionStorage.getItem(storageKey + ':prepare'))
        action = 'restore';
      if (action === 'restart' && startState(current, dispatchUncertain) !== 'failed') return;
      if (action === 'restart') {
        sessionStorage.removeItem(storageKey + ':prepare');
        action = 'prepare';
      }
      if (action === 'restore') {
        // Legacy sessions store the operation ID, not the preparation ID. Lookup
        // must not replay POST prepare, create a campaign, quote or dispatch.
        const operationId = sessionStorage.getItem(storageKey + ':prepare');
        current = operationId
          ? await api<StartPreparation | null>(
              `/game/start-preparations/by-operation/${encodeURIComponent(operationId)}`,
            )
          : null;
      } else if (action === 'prepare') {
        const legacyReplay =
          directorSelection.legacy &&
          !!sessionStorage.getItem(storageKey + ':prepare') &&
          sessionStorage.getItem(storageKey + ':director-included') !== 'yes';
        // A safely replaced legacy operation starts including the chosen profile.
        // Remember that request shape so a later reload replays the same hash.
        if (directorSelection.legacy && !legacyReplay)
          sessionStorage.setItem(storageKey + ':director-included', 'yes');
        directorSelection.lock();
        current = await api<StartPreparation>('/game/start-preparations', {
          method: 'POST',
          body: JSON.stringify({
            operationId: operation('prepare'),
            playableVersionId: versionId,
            ...(legacyReplay ? {} : { directorProfileId: directorSelection.profileId }),
            ...heroSelection.body,
          }),
        });
        current = await api<StartPreparation>(`/game/start-preparations/${current.id}`);
      } else if ((action === 'refresh' || action === 'open') && current) {
        current = await api<StartPreparation>(`/game/start-preparations/${current.id}`);
      } else if (action === 'confirm' && current && quote) {
        if (
          startState(current, dispatchUncertain) !== 'estimate' ||
          Date.parse(quote.expiresAt) <= Date.now()
        )
          return;
        sessionStorage.setItem(storageKey + ':dispatch-pending', 'yes');
        setDispatchUncertain(true);
        setConfirm(false);
        current = await api<StartPreparation>(`/game/start-preparations/${current.id}/dispatch`, {
          method: 'POST',
          body: JSON.stringify({
            operationId: operation('dispatch:' + quote.id),
            quoteId: quote.id,
            consent: true,
          }),
        });
      }
      if (!gate.accepts(lease)) return;
      setPreparation(current);
      if (action === 'restore') setRestorationUncertain(false);
      if (!current) return;
      if (current.campaignId && action === 'restore') {
        // A completed launch is a save, not an instruction to enter or reuse its
        // idempotency key. Only finished starts retire; uncertain/pending starts
        // retain their identity and the existing settlement/consent protection.
        setCompletedSave({ scope: saveScope, id: current.campaignId });
        sessionStorage.removeItem(storageKey + ':prepare');
        sessionStorage.removeItem(storageKey + ':dispatch-pending');
        sessionStorage.removeItem(storageKey + ':director-included');
        setDispatchUncertain(false);
        setPreparation(null);
        directorSelection.releaseCompleted();
        return;
      }
      if (current.jobs?.length || current.status === 'ready' || current.campaignId) {
        sessionStorage.removeItem(storageKey + ':dispatch-pending');
        setDispatchUncertain(false);
      }
      if ((current.status === 'ready' || current.campaignId) && mayEnter) {
        const result = current.campaignId
          ? { campaignId: current.campaignId }
          : await api<{ campaignId: string }>('/game/campaigns', {
              method: 'POST',
              body: JSON.stringify({
                playableVersionId: versionId,
                startPreparationId: current.id,
                directorProfileId: current.directorProfileId || directorSelection.profileId,
                turnBased: true,
                ...heroSelection.body,
              }),
            });
        if (gate.accepts(lease)) {
          router.push(`/game/${result.campaignId}`);
          navigating = true;
        }
      } else if (action === 'prepare' && !current.jobs?.length && !dispatchUncertain) {
        const next = await api<Quote>(`/game/start-preparations/${current.id}/quote`, {
          method: 'POST',
          body: JSON.stringify({ operationId: crypto.randomUUID() }),
        });
        if (gate.accepts(lease)) {
          setQuote(next);
          setConfirm(true);
        }
      } else {
        setConfirm(false);
      }
    } catch (err) {
      if (gate.accepts(lease)) {
        if (action === 'restore') setRestorationUncertain(true);
        // These explicit responses are rejected before admission. A network error,
        // unknown response, or any other code must retain the pending-dispatch guard.
        if (
          action === 'confirm' &&
          err instanceof ApiError &&
          err.status === 409 &&
          [
            'GENERATION_POLICY_CHANGED',
            'AUTHORING_QUOTE_EXPIRED',
            'GENERATION_RELEASE_PROFILE_NOT_ACTIVE',
          ].includes(err.code)
        ) {
          sessionStorage.removeItem(storageKey + ':dispatch-pending');
          setDispatchUncertain(false);
          setQuote(null);
          setConfirm(false);
        }
        if (
          err instanceof ApiError &&
          err.status === 409 &&
          err.code === 'START_PREPARATION_STALE' &&
          action !== 'confirm' &&
          !dispatchUncertain &&
          !sessionStorage.getItem(storageKey + ':dispatch-pending') &&
          (!preparation || (preparation.status === 'prepared' && !preparation.jobs?.length))
        ) {
          sessionStorage.removeItem(storageKey + ':prepare');
          setPreparation(null);
          setQuote(null);
          setConfirm(false);
        }
        setError(
          err instanceof ApiError && err.code === 'DIRECTOR_UNAVAILABLE'
            ? t('DIRECTOR_UNAVAILABLE')
            : errorMessage(err),
        );
        if (err instanceof ApiError && err.code === 'DIRECTOR_UNAVAILABLE') {
          directorSelection.resource.reload();
          // This response is rejected before preparation admission. Unknown/network
          // results keep the pinned choice and every dispatch guard untouched.
          if (
            action === 'prepare' &&
            !preparation &&
            !dispatchUncertain &&
            !sessionStorage.getItem(storageKey + ':dispatch-pending')
          ) {
            sessionStorage.removeItem(storageKey + ':prepare');
            directorSelection.unlock();
          }
        }
      }
    } finally {
      if (action === 'restore' && gate.accepts(lease)) setRestoredKey(storageKey);
      if (!navigating && gate.finish(lease)) setBusy(false);
    }
  }
  const state = startState(preparation, dispatchUncertain || restorationUncertain);
  useEffect(() => {
    if (busy || error || !['running', 'checking'].includes(state)) return;
    const timer = setTimeout(() => void launch('refresh'), 2500);
    return () => clearTimeout(timer);
  }, [preparation, state, busy, error, storageKey]);
  const status =
    state === 'review'
      ? 'Подготовка не удалась. Резерв искр ещё проверяется; повторный запуск недоступен.'
      : state === 'unknown'
        ? 'Результат запроса пока неизвестен. Повторный запуск недоступен, пока проверяется резерв.'
        : state === 'failed'
          ? 'Не удалось подготовить игру. Можно запросить новую оценку.'
          : state === 'running'
            ? entryKey === storageKey
              ? 'Готовим игру. Она откроется автоматически.'
              : 'Подготовка игры'
            : state === 'checking'
              ? 'Проверяем результат запроса. Повторной оплаты не будет.'
              : '';
  const primaryAction =
    state === 'failed'
      ? 'restart'
      : state === 'ready'
        ? 'open'
        : ['review', 'unknown', 'running', 'checking'].includes(state)
          ? 'refresh'
          : 'prepare';
  return (
    <>
      {continueId && (
        <div className="stack" data-testid="story-saves">
          {saveIds.length > 1 && (
            <Field label={t('Сохранённое прохождение')}>
              <Select value={continueId} onChange={(event) => setSelectedSave(event.target.value)}>
                {saveIds.map((id) => {
                  const save = savedCampaigns.find((entry) => entry.id === id);
                  const updated = save?.updatedAt ? new Date(save.updatedAt) : null;
                  return (
                    <option key={id} value={id}>
                      {t('Сохранение')} {id.slice(0, 8)}
                      {updated && Number.isFinite(updated.getTime())
                        ? ` · ${updated.toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })}`
                        : ''}
                    </option>
                  );
                })}
              </Select>
            </Field>
          )}
          <Link className="button" href={`/game/${encodeURIComponent(continueId)}`}>
            {t('Продолжить игру')}
          </Link>
        </div>
      )}
      {user && saves.error && <ErrorBox message={saves.error} retry={saves.reload} />}
      <HeroSelection
        selection={heroSelection}
        disabled={busy || directorSelection.locked || state !== 'estimate'}
        compact
        presentation={{
          title: selectAdventureText(adventure, locale).title,
          synopsis: selectAdventureText(adventure, locale).synopsis,
          genre: taxonomy(adventure.genre),
          playersMin: adventure.playersMin,
          playersMax: adventure.playersMax,
          cover: coverUrl(adventure),
          manageHref: withStoryReturn(
            '/my-characters',
            storyReturnPath(adventure.slug, heroSelection.heroId) ||
              storyReturnPath(adventure.slug),
          ),
        }}
      />
      <DirectorSelection
        selection={directorSelection}
        disabled={busy || state !== 'estimate'}
        locked={directorSelection.locked}
      />
      {status && <p role="status">{t(status)}</p>}
      {Boolean(preparation?.jobs?.[0]?.error_code?.startsWith('MAP_IMAGE_')) && (
        <p>
          {t(
            'Не удалось уверенно определить безопасный старт на изображении карты. План не применён.',
          )}
        </p>
      )}
      {!confirm && (
        <Button
          type="button"
          variant={continueId ? 'secondary' : 'primary'}
          disabled={
            authLoading ||
            (!!user &&
              ['prepare', 'restart'].includes(primaryAction) &&
              (saves.loading || (!savesLoaded && !saves.error))) ||
            (!!user && restoredKey !== storageKey) ||
            !versionId ||
            versions.loading ||
            !heroSelection.ready ||
            !directorSelection.hydrated ||
            (!directorSelection.ready && !preparation) ||
            (state === 'failed' && !directorSelection.ready) ||
            (state === 'running' && !error)
          }
          busy={busy || (state === 'running' && !error)}
          onClick={() => void launch(primaryAction)}
        >
          {t(
            state === 'failed'
              ? 'Новая оценка'
              : ['review', 'unknown', 'checking'].includes(state) ||
                  (state === 'running' && !!error)
                ? 'Проверить состояние'
                : state === 'running'
                  ? 'Подготовка игры'
                  : state === 'ready'
                    ? 'Открыть игру'
                    : continueId
                      ? 'Начать заново'
                      : 'Начать прохождение',
          )}
        </Button>
      )}
      {continueId && (
        <small className="muted">{t('Новое прохождение не удалит сохранения.')}</small>
      )}
      {!versionId && !versions.loading && (
        <small>{t('У этой истории пока нет доступной игровой версии.')}</small>
      )}
      {confirm && quote && (
        <Modal
          title={t('Подготовить игру?')}
          onClose={() => {
            if (!busy) setConfirm(false);
          }}
        >
          <MapImageNotice count={quote.imageInputCount} schematicCount={quote.schematicMapCount} />
          <p>
            {t('Оценка в искрах')}:{' '}
            {estimatedSubunits === null ? '—' : formatSparkSubunits(estimatedSubunits)}
          </p>
          <p>
            {t('Резерв искр')}:{' '}
            {quote.sparks ? formatSparkSubunits(quote.sparks.reserveSubunits) : '—'}
          </p>
          <small>
            {t('После подготовки спишется фактическая стоимость, остаток резерва вернётся.')}
          </small>
          <Button
            busy={busy}
            disabled={!quote.sparks || Date.parse(quote.expiresAt) <= Date.now()}
            onClick={() => void launch('confirm')}
          >
            {t('Подтвердить и начать')}
          </Button>
        </Modal>
      )}
      <ErrorBox message={error || versions.error} />
    </>
  );
}

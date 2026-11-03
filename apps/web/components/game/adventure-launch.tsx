'use client';
import { MapImageNotice } from './map-image-notice';
import { storyReturnPath, withStoryReturn } from '../story-return';
import { HeroSelection, useHeroSelection } from './hero-selection';
import { useLaunchGate } from './use-launch-gate';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { startState, type StartPreparation } from './start-state';
import { formatSparkSubunits } from '@dreamwalk/contracts';
import { providerSparkSubunits } from '../visual-authoring/spark-equivalent';
import type { Adventure } from '@dreamwalk/contracts';
import { api, errorMessage, useClient, useResource } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Button, ErrorBox, Modal } from '@/components/ui';
export function AdventureLaunch({ adventure }: { adventure: Adventure }) {
  const { t } = useT();
  const heroSelection = useHeroSelection();
  const router = useRouter();
  const { user, loading: authLoading } = useClient();
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
  const gate = useLaunchGate(`${user?.id}:${adventure.id}:${versionId}:${heroSelection.heroId}`);
  type Quote = {
    imageInputCount?: number;
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
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const storageKey = `dreamwalk-start:${user?.id}:${versionId}:${heroSelection.heroId}`;
  useEffect(() => {
    setPreparation(null);
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
      !busy &&
      restoredKey !== storageKey &&
      sessionStorage.getItem(storageKey + ':prepare')
    )
      void launch('restore');
  }, [storageKey, heroSelection.ready, busy, restoredKey]);
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
    action: 'prepare' | 'confirm' | 'refresh' | 'restart' | 'restore' = 'prepare',
  ) {
    if (!user) {
      router.push(
        withStoryReturn('/auth/sign-in', storyReturnPath(adventure.slug, heroSelection.heroId)),
      );
      return;
    }
    if (!versionId || !heroSelection.ready) return;
    const lease = gate.begin();
    if (!lease) return;
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
      if (action === 'prepare' || action === 'restore') {
        current = await api<StartPreparation>('/game/start-preparations', {
          method: 'POST',
          body: JSON.stringify({
            operationId: operation('prepare'),
            playableVersionId: versionId,
            ...heroSelection.body,
          }),
        });
        current = await api<StartPreparation>(`/game/start-preparations/${current.id}`);
      } else if (action === 'refresh' && current) {
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
      if (!gate.accepts(lease) || !current) return;
      setPreparation(current);
      if (current.jobs?.length || current.status === 'ready' || current.campaignId) {
        sessionStorage.removeItem(storageKey + ':dispatch-pending');
        setDispatchUncertain(false);
      }
      if (current.status === 'ready' || current.campaignId) {
        const result = current.campaignId
          ? { campaignId: current.campaignId }
          : await api<{ campaignId: string }>('/game/campaigns', {
              method: 'POST',
              body: JSON.stringify({
                playableVersionId: versionId,
                startPreparationId: current.id,
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
      if (gate.accepts(lease)) setError(errorMessage(err));
    } finally {
      if (action === 'restore' && gate.accepts(lease)) setRestoredKey(storageKey);
      if (!navigating && gate.finish(lease)) setBusy(false);
    }
  }
  const state = startState(preparation, dispatchUncertain);
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
            ? 'Готовим игру. Она откроется автоматически.'
            : state === 'checking'
              ? 'Проверяем результат запроса. Повторной оплаты не будет.'
              : '';
  const primaryAction =
    state === 'failed'
      ? 'restart'
      : ['review', 'unknown', 'running', 'checking', 'ready'].includes(state)
        ? 'refresh'
        : 'prepare';
  return (
    <>
      <HeroSelection selection={heroSelection} disabled={busy || state !== 'estimate'} compact />
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
          disabled={
            authLoading ||
            (!!user && restoredKey !== storageKey) ||
            !versionId ||
            versions.loading ||
            !heroSelection.ready ||
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
                    : 'Начать прохождение',
          )}
        </Button>
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
          <MapImageNotice count={quote.imageInputCount} />
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

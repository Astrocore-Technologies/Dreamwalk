'use client';
import { storyReturnPath, withStoryReturn } from '../story-return';
import { HeroSelection, useHeroSelection } from './hero-selection';
import { useLaunchGate } from './use-launch-gate';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { formatSparkSubunits } from '@dreamwalk/contracts';
import type { Adventure } from '@dreamwalk/contracts';
import { api, errorMessage, useClient, useResource } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Button, ErrorBox, Modal } from '@/components/ui';
export function AdventureLaunch({ adventure }: { adventure: Adventure }) {
  const { t } = useT();
  const heroSelection = useHeroSelection();
  const router = useRouter();
  const { user } = useClient();
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
  type Preparation = {
    id: string;
    status: string;
    reused: boolean;
    campaignId: string | null;
    jobs?: { status: string; error_code?: string }[];
  };
  type Quote = {
    id: string;
    expiresAt: string;
    sparks?: { reserveSubunits: string };
    estimatedTotalMicros?: number;
  };
  const [preparation, setPreparation] = useState<Preparation | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [confirm, setConfirm] = useState(false);
  const storageKey = `dreamwalk-start:${user?.id}:${versionId}:${heroSelection.heroId}`;
  useEffect(() => {
    setPreparation(null);
    setQuote(null);
    setConfirm(false);
  }, [storageKey]);
  function operation(suffix: string) {
    const key = storageKey + ':' + suffix;
    let id = sessionStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem(key, id);
    }
    return id;
  }
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function launch(action: 'prepare' | 'confirm' | 'refresh' | 'restart' = 'prepare') {
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
      if (action === 'restart') {
        sessionStorage.removeItem(storageKey + ':prepare');
        action = 'prepare';
      }
      if (action === 'prepare') {
        current = await api<Preparation>('/game/start-preparations', {
          method: 'POST',
          body: JSON.stringify({
            operationId: operation('prepare'),
            playableVersionId: versionId,
            ...heroSelection.body,
          }),
        });
        current = await api<Preparation>(`/game/start-preparations/${current.id}`);
      } else if (action === 'refresh' && current) {
        current = await api<Preparation>(`/game/start-preparations/${current.id}`);
      } else if (action === 'confirm' && current && quote) {
        current = await api<Preparation>(`/game/start-preparations/${current.id}/dispatch`, {
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
      } else if (action === 'prepare' && !current.jobs?.length) {
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
      if (!navigating && gate.finish(lease)) setBusy(false);
    }
  }
  return (
    <>
      <HeroSelection selection={heroSelection} disabled={busy} />
      <Button
        type="button"
        disabled={!versionId || versions.loading || !heroSelection.ready}
        busy={busy}
        onClick={() => void launch('prepare')}
      >
        {t('Начать прохождение')}
      </Button>
      <small>
        {t(
          versionId
            ? 'Прохождение закрепляется за проверенной игровой версией. Новые правки автора его не изменят.'
            : 'У этой истории пока нет доступной игровой версии.',
        )}
      </small>
      <p>
        {t(
          'Готовый план используется бесплатно. Если нужна подготовка, перед оплатой покажем стоимость в искрах. Возвращение в игру и присоединение не оплачиваются повторно.',
        )}
      </p>
      {preparation && preparation.status === 'prepared' && !confirm && (
        <div role="status">
          <p>
            {t('Подготовка ещё не завершена. Обновите состояние; повторного списания не будет.')}
          </p>
          {preparation.jobs?.some((j) =>
            ['failed', 'rejected', 'stale', 'cancelled'].includes(j.status),
          ) && (
            <Button busy={busy} onClick={() => void launch('restart')}>
              {t('Новая попытка с новой оценкой')}
            </Button>
          )}
          <Button busy={busy} onClick={() => void launch('refresh')}>
            {t('Обновить состояние')}
          </Button>
        </div>
      )}
      {confirm && quote && (
        <Modal
          title={t('Подготовить игру?')}
          onClose={() => {
            if (!busy) setConfirm(false);
          }}
        >
          <p>
            {t(
              'Оплата подготовки списывается с вашего баланса, не с автора истории. Сохранённые изображения используются повторно.',
            )}
          </p>
          <p>
            {t('Оценка в искрах')}:{' '}
            {quote.estimatedTotalMicros === undefined
              ? '—'
              : formatSparkSubunits(String(quote.estimatedTotalMicros))}
          </p>
          <p>
            {t('Резерв искр')}:{' '}
            {quote.sparks ? formatSparkSubunits(quote.sparks.reserveSubunits) : '—'}
          </p>
          <p>{t('После подготовки спишется фактическая стоимость, остаток резерва вернётся.')}</p>
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

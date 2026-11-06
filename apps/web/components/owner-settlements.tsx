'use client';
import { useEffect, useState } from 'react';
import { formatSparkSubunits } from '@dreamwalk/contracts';
import { api, useClient } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { readOwnerSettlements, type OwnerSettlementEntry } from '@/lib/owner-settlements';
import { Button, ButtonLink, ErrorBox, Loading, PageHeading, Panel } from './ui';
import { OwnerAuthoringSettlement } from './visual-authoring/owner-authoring-settlement';

const messages = {
  ru: {
    title: 'Резервы кошелька',
    hint: 'Проверенная стоимость и статус открытых резервов. Новые операции рассчитываются автоматически; для старых операций без такого согласия доступно отдельное подтверждение.',
    empty: 'Открытых резервов нет.',
    unavailable:
      'Подтверждённый расчёт пока недоступен. Этот резерв нельзя закрыть без доказанного результата и стоимости.',
    error: 'Не удалось проверить резервы. Никакие суммы не изменены.',
    review: 'Проверить старую операцию',
    status: 'Посмотреть статус',
    reserve: 'Резерв, эквивалент искр',
    reference: 'Номер резерва',
    back: 'К кошельку',
    more: 'Следующие резервы',
    refresh: 'Обновить',
    authoring: 'Создание истории',
    game: 'Игровой запрос',
  },
  en: {
    title: 'Wallet reservations',
    hint: 'Verified costs and open reservation status. New operations settle automatically; older operations without that consent have a separate confirmation.',
    empty: 'There are no open reservations.',
    unavailable:
      'Verified settlement is not available yet. This reservation cannot be closed without a proven outcome and cost.',
    error: 'Reservations could not be verified. No amounts were changed.',
    review: 'Review older operation',
    status: 'View status',
    reserve: 'Reservation, in Spark equivalents',
    reference: 'Reservation reference',
    back: 'Wallet',
    more: 'Next reservations',
    refresh: 'Refresh',
    authoring: 'Story creation',
    game: 'Game request',
  },
  uk: {
    title: 'Резерви гаманця',
    hint: 'Перевірена вартість і статус відкритих резервів. Нові операції розраховуються автоматично; для старих операцій без такої згоди доступне окреме підтвердження.',
    empty: 'Відкритих резервів немає.',
    unavailable:
      'Підтверджений розрахунок поки недоступний. Цей резерв не можна закрити без доведеного результату й вартості.',
    error: 'Не вдалося перевірити резерви. Жодні суми не змінено.',
    review: 'Перевірити стару операцію',
    status: 'Переглянути статус',
    reserve: 'Резерв, еквівалент іскор',
    reference: 'Номер резерву',
    back: 'До гаманця',
    more: 'Наступні резерви',
    refresh: 'Оновити',
    authoring: 'Створення історії',
    game: 'Ігровий запит',
  },
} as const;
export function WalletSettlementLink() {
  const { locale } = useT();
  return (
    <ButtonLink href="/wallet/settlements" variant="ghost">
      {messages[locale].title}
    </ButtonLink>
  );
}
export function OwnerAuthoringSettlementPage({ jobId }: { jobId: string }) {
  const { locale } = useT();
  const text = messages[locale];
  return (
    <div className="stack">
      <PageHeading title={text.authoring} />
      <Panel>
        <OwnerAuthoringSettlement jobId={jobId} />
      </Panel>
      <WalletSettlementLink />
    </div>
  );
}
export function WalletSettlementsPage() {
  const { user } = useClient();
  return user ? <Reservations key={user.id} ownerId={user.id} /> : null;
}
function Reservations({ ownerId }: { ownerId: string }) {
  const { locale } = useT();
  const text = messages[locale];
  const [cursor, setCursor] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<{
    entries: OwnerSettlementEntry[];
    nextCursor: string | null;
    loading: boolean;
    error: boolean;
  }>({ entries: [], nextCursor: null, loading: true, error: false });
  useEffect(() => {
    let disposed = false;
    setState({ entries: [], nextCursor: null, loading: true, error: false });
    void api(`/sparks/settlements${cursor ? `?after=${encodeURIComponent(cursor)}` : ''}`, {
      cache: 'no-store',
    })
      .then((value) => {
        const result = readOwnerSettlements(value, ownerId);
        if (!disposed) setState({ ...result, loading: false, error: false });
      })
      .catch(() => {
        if (!disposed) setState({ entries: [], nextCursor: null, loading: false, error: true });
      });
    return () => {
      disposed = true;
    };
  }, [ownerId, cursor, refresh]);
  return (
    <div className="stack" data-testid="wallet-settlements">
      <PageHeading title={text.title} description={text.hint} />
      <ErrorBox message={state.error ? text.error : ''} />
      {state.loading ? (
        <Loading />
      ) : !state.error && !state.entries.length ? (
        <p>{text.empty}</p>
      ) : null}
      {state.entries.map((entry) => (
        <Panel key={entry.holdId}>
          <div className="stack">
            <p>
              {text.reference}: <span>{entry.holdId}</span>
            </p>
            <p>
              {text.reserve}:{' '}
              <strong>{formatSparkSubunits(entry.reservedSubunits, locale, 'exact')}</strong>
            </p>
            {entry.state === 'verified' ? (
              <>
                <p>{entry.kind === 'authoring' ? text.authoring : text.game}</p>
                <ButtonLink
                  href={
                    entry.kind === 'authoring'
                      ? `/wallet/settlements/authoring/${entry.jobId}`
                      : `/game/${entry.campaignId}/settlement/${entry.jobId}`
                  }
                >
                  {entry.quote.settlementMode === 'legacy_confirmation' &&
                  entry.quote.status === 'pending'
                    ? text.review
                    : text.status}
                </ButtonLink>
              </>
            ) : (
              <p>{text.unavailable}</p>
            )}
          </div>
        </Panel>
      ))}
      <div className="row wrap">
        <Button
          type="button"
          disabled={state.loading}
          onClick={() => {
            setCursor(null);
            setRefresh((n) => n + 1);
          }}
        >
          {text.refresh}
        </Button>
        {state.nextCursor && (
          <Button type="button" onClick={() => setCursor(state.nextCursor)}>
            {text.more}
          </Button>
        )}
        <ButtonLink href="/wallet" variant="ghost">
          {text.back}
        </ButtonLink>
      </div>
    </div>
  );
}

'use client';
import { MoonStar } from 'lucide-react';
import { formatSparkSubunits } from '@dreamwalk/contracts';
import { useT } from '@/lib/i18n';
import { useDate } from '@/lib/client';
import { useDreamsWallet } from '@/lib/use-dreams-wallet';
import { Empty, ErrorBox, Loading, Panel } from './ui';
const messages = {
  ru: {
    name: 'Грёзы',
    title: 'Мой кошелёк',
    description: 'Грёзы и искры хранятся отдельно. Здесь видны реальные остатки и операции.',
    available: 'Доступно грёз',
    held: 'В резерве',
    loading: 'Загружаем баланс грёз',
    unavailable: 'Баланс грёз недоступен',
    pendingPolicy: 'Грёзы сохранены в кошельке. Оплата ими пока недоступна.',
    history: 'История грёз',
    empty: 'Здесь появятся начисления и расходы грёз.',
    operation: 'Операция',
    date: 'Дата',
    starter_grant: 'Стартовый подарок',
    admin_credit: 'Выдано администратором',
    reserve: 'Резерв',
    pending: 'На сверке',
    capture: 'Списано',
    release: 'Возврат резерва',
  },
  uk: {
    name: 'Мрії',
    title: 'Мій гаманець',
    description: 'Мрії та іскри зберігаються окремо. Тут видно справжні залишки й операції.',
    available: 'Доступно мрій',
    held: 'У резерві',
    loading: 'Завантажуємо баланс мрій',
    unavailable: 'Баланс мрій недоступний',
    pendingPolicy: 'Мрії збережені в гаманці. Оплата ними поки недоступна.',
    history: 'Історія мрій',
    empty: 'Тут з’являться нарахування та витрати мрій.',
    operation: 'Операція',
    date: 'Дата',
    starter_grant: 'Стартовий подарунок',
    admin_credit: 'Видано адміністратором',
    reserve: 'Резерв',
    pending: 'На звірці',
    capture: 'Списано',
    release: 'Повернення резерву',
  },
  en: {
    name: 'Dreams',
    title: 'My wallet',
    description:
      'Dreams and Sparks are stored separately. View your actual balances and transactions here.',
    available: 'Available Dreams',
    held: 'Reserved',
    loading: 'Loading Dreams balance',
    unavailable: 'Dreams balance unavailable',
    pendingPolicy: 'Your Dreams are saved in your wallet. Spending them is not available yet.',
    history: 'Dreams history',
    empty: 'Dreams credits and usage will appear here.',
    operation: 'Operation',
    date: 'Date',
    starter_grant: 'Welcome gift',
    admin_credit: 'Admin grant',
    reserve: 'Reserved',
    pending: 'Pending reconciliation',
    capture: 'Charged',
    release: 'Reservation released',
  },
};
export function useDreamsText() {
  const { locale } = useT();
  return { locale, text: messages[locale] };
}
export function DreamsBalance({ ownerId }: { ownerId: string }) {
  const { locale, text } = useDreamsText();
  const wallet = useDreamsWallet(ownerId);
  const amount = wallet.data ? formatSparkSubunits(wallet.data.availableSubunits, locale) : null;
  const label =
    amount !== null
      ? `${text.available}: ${amount}`
      : wallet.unavailable
        ? text.unavailable
        : text.loading;
  return (
    <strong
      className="dreams-balance"
      data-testid="dreams-balance"
      aria-live="polite"
      aria-label={label}
      title={label}
    >
      {amount ?? (wallet.unavailable ? '—' : '…')}
    </strong>
  );
}
export function DreamsWalletSection({
  part = 'all',
  wallet,
}: {
  part?: 'all' | 'balance' | 'history';
  wallet: ReturnType<typeof useDreamsWallet>;
}) {
  const { locale, text } = useDreamsText();
  const date = useDate();
  return (
    <section
      className={part === 'all' ? 'dreams-wallet-section' : `dreams-wallet-${part}`}
      aria-label={part === 'history' ? text.history : text.name}
    >
      {part !== 'history' && (
        <div className="balance-card dreams-card">
          <MoonStar size={24} />
          <p>{text.available}</p>
          <h2 data-testid="wallet-dreams-balance" aria-live="polite">
            {wallet.data
              ? formatSparkSubunits(wallet.data.availableSubunits, locale)
              : wallet.unavailable
                ? '—'
                : '…'}
          </h2>
          {wallet.data && (
            <small>
              {text.held}: {formatSparkSubunits(wallet.data.heldSubunits, locale, 'exact')}
            </small>
          )}
          {wallet.data && !wallet.data.spendingAvailable && (
            <p className="muted">{text.pendingPolicy}</p>
          )}
        </div>
      )}
      {part !== 'history' && (
        <ErrorBox message={wallet.unavailable ? text.unavailable : ''} retry={wallet.reload} />
      )}
      {part !== 'balance' && (
        <Panel>
          <h2>{text.history}</h2>
          {!wallet.data && !wallet.unavailable ? (
            <Loading />
          ) : wallet.data?.ledger.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{text.operation}</th>
                    <th>{text.date}</th>
                    <th>{text.name}</th>
                  </tr>
                </thead>
                <tbody>
                  {wallet.data.ledger.map((entry) => (
                    <tr key={entry.id}>
                      <td>{text[entry.kind]}</td>
                      <td>{date(entry.createdAt)}</td>
                      <td>
                        {entry.kind === 'starter_grant' || entry.kind === 'admin_credit'
                          ? '+'
                          : entry.kind === 'capture'
                            ? '−'
                            : ''}
                        {formatSparkSubunits(entry.amountSubunits, locale, 'exact')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : wallet.data ? (
            <Empty title={text.history} description={text.empty} />
          ) : null}
        </Panel>
      )}
    </section>
  );
}

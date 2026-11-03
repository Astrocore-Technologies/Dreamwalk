'use client';
import { formatSparkSubunits } from '@dreamwalk/contracts';
import { providerSparkSubunits } from './spark-equivalent';
import { useT } from '@/lib/i18n';
export const sparkCostMessages = {
  unit: ['Искр', 'Sparks', 'Іскор'],
  estimate: ['Оценка в Искрах', 'Estimated Sparks equivalent', 'Оцінка в Іскрах'],
  reserve: [
    'Резерв провайдера в Искрах',
    'Provider reserve in Sparks',
    'Резерв провайдера в Іскрах',
  ],
  actual: ['Расход провайдера в Искрах', 'Provider spend in Sparks', 'Витрата провайдера в Іскрах'],
  upper: ['Верхняя оценка в Искрах', 'Upper estimate in Sparks', 'Верхня оцінка в Іскрах'],
  notice: [
    'Показан эквивалент расходов провайдера в Искрах. Это не списание и не резерв кошелька: оплата Искрами ещё не включена.',
    'Provider costs are shown as a Sparks equivalent. These are not wallet charges or wallet holds: Sparks billing is not active yet.',
    'Показано еквівалент витрат провайдера в Іскрах. Це не списання й не резерв гаманця: оплата Іскрами ще не ввімкнена.',
  ],
  blocked: [
    'Генерация сейчас недоступна. Нужен разрешённый лимит; администратор может проверить ограничения.',
    'Generation is currently unavailable. An authorized limit is required; an administrator can review the safeguards.',
    'Генерація зараз недоступна. Потрібен дозволений ліміт; адміністратор може перевірити обмеження.',
  ],
} as const;
export function useSparkCosts() {
  const { locale } = useT();
  const s = (key: keyof typeof sparkCostMessages) =>
    sparkCostMessages[key][locale === 'ru' ? 0 : locale === 'en' ? 1 : 2];
  const amount = (micros: number | undefined | null, rateVersion?: string | null) => {
    const subunits = providerSparkSubunits(micros, rateVersion);
    if (subunits === null) return <span>—</span>;
    return (
      <span title={`${formatSparkSubunits(subunits, locale, 'exact')} ${s('unit')}`}>
        {formatSparkSubunits(subunits, locale)} {s('unit')}
      </span>
    );
  };
  return { s, amount };
}
export function SparksEquivalentNotice() {
  const { s } = useSparkCosts();
  return <small data-sparks-equivalent-only>{s('notice')}</small>;
}

export type SparkQuotedCharge = {
  sparks?: { quoteId: string; reserveSubunits: string; rateVersion: string; walletCharging: true };
  chargeUnit?: 'sparks' | 'credits';
  sparkReservedSubunits?: string | null;
  credits?: number;
};
/** A reservation is not a final debit; disabled/demo values remain explicitly separate. */
export function SparkQuotePrice({ quote }: { quote: SparkQuotedCharge }) {
  const { locale } = useT();
  const reserved = quote.sparks?.walletCharging
    ? quote.sparks.reserveSubunits
    : quote.chargeUnit === 'sparks'
      ? quote.sparkReservedSubunits
      : null;
  const label =
    locale === 'ru' ? 'Резерв Искр' : locale === 'uk' ? 'Резерв Іскор' : 'Sparks reservation';
  const demo =
    locale === 'ru'
      ? 'Демонстрационные единицы'
      : locale === 'uk'
        ? 'Демонстраційні одиниці'
        : 'Demo units';
  return (
    <p data-spark-quote-price>
      {reserved !== undefined && reserved !== null ? (
        <>
          {label}:{' '}
          <span title={formatSparkSubunits(reserved, locale, 'exact')}>
            {formatSparkSubunits(reserved, locale)}
          </span>{' '}
          ✦
        </>
      ) : (
        <>
          {demo}: {quote.credits ?? 0}
        </>
      )}
    </p>
  );
}
export function SparkQuoteNotice({ quote }: { quote: SparkQuotedCharge }) {
  const { locale } = useT();
  if (quote.sparks?.walletCharging || quote.chargeUnit === 'sparks')
    return (
      <small data-sparks-wallet-charge>
        {locale === 'ru'
          ? 'После согласия Искры резервируются в кошельке. Подтверждённая стоимость списывается один раз, остаток освобождается. Неизвестный расход остаётся на сверке.'
          : locale === 'uk'
            ? 'Після згоди Іскри резервуються в гаманці. Підтверджена вартість списується один раз, залишок звільняється. Невідома витрата залишається на звірці.'
            : 'After consent, Sparks are reserved in your wallet. Confirmed cost is captured once and the remainder released. Unknown costs remain pending reconciliation.'}
      </small>
    );
  return <SparksEquivalentNotice />;
}
export function ProviderSparkReserve({
  quote,
}: {
  quote: {
    providerReserveMicros?: number;
    providerUpperMicros?: number | null;
    chargeUnit?: string;
    sparkRateVersion?: string;
  };
}) {
  const { s, amount } = useSparkCosts(),
    { locale } = useT();
  const reserve = quote.providerReserveMicros ?? quote.providerUpperMicros;
  return (
    <p>
      {s('reserve')}:{' '}
      {amount(
        reserve,
        quote.chargeUnit === 'sparks' ? (quote.sparkRateVersion ?? null) : undefined,
      )}{' '}
      {quote.providerReserveMicros !== undefined && (
        <small>
          {locale === 'ru'
            ? 'Это резерв по оценке, а не лимит счёта, принудительно установленный провайдером.'
            : locale === 'uk'
              ? 'Це резерв за оцінкою, а не ліміт рахунку, примусово встановлений провайдером.'
              : 'This estimate-based reserve is not a provider-enforced invoice cap.'}
        </small>
      )}
    </p>
  );
}

export function SparkReceiptCost({
  receipt,
}: {
  receipt: {
    sparkStatus?: string;
    sparkReservedSubunits?: string;
    sparkCapturedSubunits?: string | null;
    generationCost: number | null;
  };
}) {
  const { locale } = useT();
  if (!receipt.sparkStatus)
    return (
      <>
        {locale === 'ru'
          ? 'Демонстрационные единицы'
          : locale === 'uk'
            ? 'Демонстраційні одиниці'
            : 'Demo units'}
        : {receipt.generationCost ?? '—'}
      </>
    );
  const status = receipt.sparkStatus;
  const label =
    status === 'released'
      ? locale === 'ru'
        ? 'Резерв освобождён'
        : locale === 'uk'
          ? 'Резерв звільнено'
          : 'Reservation released'
      : status === 'held'
        ? locale === 'ru'
          ? 'Зарезервировано Искр'
          : locale === 'uk'
            ? 'Зарезервовано Іскор'
            : 'Sparks reserved'
        : status === 'pending'
          ? locale === 'ru'
            ? 'Удерживается до сверки'
            : locale === 'uk'
              ? 'Утримується до звірки'
              : 'Held pending reconciliation'
          : locale === 'ru'
            ? 'Списано Искр'
            : locale === 'uk'
              ? 'Списано Іскор'
              : 'Sparks captured';
  const units =
    status === 'settled' ? receipt.sparkCapturedSubunits : receipt.sparkReservedSubunits;
  return (
    <span
      data-spark-receipt
      title={
        units !== undefined && units !== null
          ? formatSparkSubunits(units, locale, 'exact')
          : undefined
      }
    >
      {label}: {units !== undefined && units !== null ? formatSparkSubunits(units, locale) : '—'} ✦
    </span>
  );
}

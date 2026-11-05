'use client';
import { formatSparkSubunits } from '@dreamwalk/contracts';
import { useT } from '@/lib/i18n';
export interface WalletFunding {
  policyVersion: 'dreams-first-v1';
  dreamsReservedSubunits: string;
  sparksReservedSubunits: string;
  totalReservedSubunits: string;
  maxSparksSubunits: string;
  allocation: 'estimate' | 'reserved';
  dreamsCapturedSubunits?: string | null;
  sparksCapturedSubunits?: string | null;
}
const messages = {
  ru: {
    estimate: 'Оценка резерва',
    reserved: 'Зарезервировано',
    captured: 'Списано',
    dreams: 'Грёзы',
    sparks: 'Искры',
    maximum: 'Если баланс грёз изменится, резерв искр составит не более',
    notice:
      'Сначала используются Грёзы, затем Искры. Распределение фиксируется при создании резерва; подтверждённый расход списывается один раз, остаток возвращается. Неизвестный расход остаётся в резерве до проверки системой.',
    released: 'Резерв освобождён',
    pending: 'На сверке',
  },
  uk: {
    estimate: 'Оцінка резерву',
    reserved: 'Зарезервовано',
    captured: 'Списано',
    dreams: 'Мрії',
    sparks: 'Іскри',
    maximum: 'Якщо баланс мрій зміниться, резерв іскор становитиме не більше',
    notice:
      'Спочатку використовуються Мрії, потім Іскри. Розподіл фіксується під час створення резерву; підтверджена витрата списується один раз, залишок повертається. Невідома витрата залишається в резерві до перевірки системою.',
    released: 'Резерв звільнено',
    pending: 'На звірці',
  },
  en: {
    estimate: 'Estimated reservation',
    reserved: 'Reserved',
    captured: 'Charged',
    dreams: 'Dreams',
    sparks: 'Sparks',
    maximum: 'If your Dreams balance changes, the Sparks reservation will not exceed',
    notice:
      'Dreams are used first, then Sparks. The split is fixed when the reservation is created; confirmed cost is charged once and the remainder released. Unknown costs stay reserved until the system can verify them.',
    released: 'Reservation released',
    pending: 'Pending reconciliation',
  },
};
export function FundingBreakdown({ funding, status }: { funding: WalletFunding; status?: string }) {
  const { locale } = useT();
  const text = messages[locale];
  const settled = status === 'settled';
  const amount = (value: string | null | undefined) =>
    value == null ? '—' : formatSparkSubunits(value, locale, 'exact');
  const label =
    status === 'released'
      ? text.released
      : status === 'pending'
        ? text.pending
        : settled
          ? text.captured
          : funding.allocation === 'estimate'
            ? text.estimate
            : text.reserved;
  return (
    <span className="funding-breakdown" data-wallet-funding={funding.allocation}>
      <strong>{label}</strong>
      <span>
        {text.dreams}:{' '}
        {amount(settled ? funding.dreamsCapturedSubunits : funding.dreamsReservedSubunits)} ·{' '}
        {text.sparks}:{' '}
        {amount(settled ? funding.sparksCapturedSubunits : funding.sparksReservedSubunits)}
      </span>
      {funding.allocation === 'estimate' && !status && (
        <small>
          {text.maximum} {amount(funding.maxSparksSubunits)} {text.sparks}.
        </small>
      )}
    </span>
  );
}
export function FundingNotice({
  automaticKnownCostPolicy,
}: { automaticKnownCostPolicy?: 'known-cost-v1' } = {}) {
  const { locale } = useT();
  return (
    <>
      <small data-dual-wallet-charge>{messages[locale].notice}</small>
      {automaticKnownCostPolicy === 'known-cost-v1' && (
        <small data-known-cost-consent>
          {locale === 'ru'
            ? 'Подтверждая этот запрос, вы также разрешаете однократно списать подтверждённую стоимость, если результат нельзя применить. Остаток резерва освобождается; повторного запроса к ИИ не будет.'
            : locale === 'uk'
              ? 'Підтверджуючи цей запит, ви також дозволяєте одноразово списати підтверджену вартість, якщо результат не можна застосувати. Решта резерву звільняється; повторного запиту до ШІ не буде.'
              : 'Confirming this request also authorizes its verified cost once if the result cannot be applied. The remaining reserve is released; no AI request is repeated.'}
        </small>
      )}
    </>
  );
}

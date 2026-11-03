'use client';
import { formatSparkSubunits } from '@dreamwalk/contracts';
import { providerSparkSubunits } from '../visual-authoring/spark-equivalent';
import { useT } from '@/lib/i18n';
import { useSparkCosts, type SparkQuotedCharge } from '../visual-authoring/sparks-cost';

/** The single displayed estimate is the exact immutable wallet hold, not a second price. */
export function ImageQuotePrice({
  quote,
}: {
  quote: SparkQuotedCharge & {
    reserveMicros?: number | null;
    upperMicros?: number | null;
  };
}) {
  const { locale } = useT();
  const { s } = useSparkCosts();
  const total =
    quote.funding?.totalReservedSubunits ??
    quote.sparks?.reserveSubunits ??
    providerSparkSubunits(quote.reserveMicros ?? quote.upperMicros);
  const copy = {
    ru: ['Сначала Грёзы, затем Искры.', 'Грёзы', 'Искры'],
    en: ['Dreams first, then Sparks.', 'Dreams', 'Sparks'],
    uk: ['Спочатку Мрії, потім Іскри.', 'Мрії', 'Іскри'],
  }[locale];
  return (
    <div data-image-quote-price>
      <p>
        <strong>
          {s('estimate')}:{' '}
          {total != null ? `${formatSparkSubunits(total, locale, 'exact')} ${s('unit')}` : '—'}
        </strong>
      </p>
      {quote.funding && (
        <small data-image-funding>
          {copy[0]} {copy[1]}:{' '}
          {formatSparkSubunits(quote.funding.dreamsReservedSubunits, locale, 'exact')} · {copy[2]}:{' '}
          {formatSparkSubunits(quote.funding.sparksReservedSubunits, locale, 'exact')}
        </small>
      )}
    </div>
  );
}

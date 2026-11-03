import { parseSparkInteger, type StoryQuote } from '@dreamwalk/contracts';
import { fail } from '../errors';

/** Sum immutable child quote amounts, never reprice historical quotes at today's rate. */
export function totalQuotedSparkSubunits(quotes: readonly StoryQuote[]): string {
  try {
    if (!quotes.length) throw new Error('Missing quotes');
    const total = quotes.reduce((sum, quote) => {
      if (quote.chargeUnit !== 'sparks' || typeof quote.sparkReservedSubunits !== 'string')
        throw new Error('Missing Spark reserve');
      return sum + parseSparkInteger(quote.sparkReservedSubunits);
    }, 0n);
    return parseSparkInteger(total.toString()).toString();
  } catch {
    return fail(409, 'SPARK_PRICE_UNVERIFIED', 'SPARK_PRICE_UNVERIFIED');
  }
}

/** A mixed-rate batch has no single conversion rate for provider estimates. */
export function commonQuotedSparkRate(quotes: readonly StoryQuote[]): {
  sparkRateVersion?: string;
} {
  const rate = quotes[0]?.sparkRateVersion;
  return rate && quotes.every((quote) => quote.sparkRateVersion === rate)
    ? { sparkRateVersion: rate }
    : {};
}

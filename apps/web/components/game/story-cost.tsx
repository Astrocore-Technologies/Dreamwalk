'use client';
import { FundingBreakdown, FundingNotice, type WalletFunding } from '../wallet-funding';
import { formatSparkSubunits, type StoryQuote } from '@dreamwalk/contracts';
import { providerSparkSubunits } from '../visual-authoring/spark-equivalent';
import { useT } from '@/lib/i18n';
import { useStoryText } from './story-messages';

/** One estimate for the exact prepared message; a wallet hold is not a final debit. */
export function StoryCost({ quote }: { quote: StoryQuote & { funding?: WalletFunding } }) {
  const { locale } = useT();
  const h = useStoryText();
  const reserve = quote.chargeUnit === 'sparks' ? (quote.sparkReservedSubunits ?? null) : null;
  const estimate = quote.estimateSnapshot?.estimatedTotalMicros ?? quote.estimatedTotalMicros;
  const providerEstimate = estimate ?? quote.providerReserveMicros ?? quote.providerUpperMicros;
  const amount =
    (reserve != null || quote.external
      ? providerSparkSubunits(
          providerEstimate,
          reserve != null ? (quote.sparkRateVersion ?? null) : undefined,
        )
      : null) ?? reserve;
  if (quote.funding)
    return (
      <div data-testid="story-cost">
        <FundingBreakdown funding={quote.funding} />
        <FundingNotice />
      </div>
    );
  return (
    <div data-testid="story-cost">
      <p data-spark-quote-price>
        <strong>
          {amount !== null
            ? h('estimatedCost', { amount: formatSparkSubunits(amount, locale) })
            : quote.external
              ? h('noBound')
              : quote.credits > 0
                ? h('cost', { credits: quote.credits })
                : h('freeTurn')}
        </strong>
      </p>
      {reserve != null && (
        <small data-sparks-wallet-charge>
          {h('estimatedHold', { amount: formatSparkSubunits(reserve, locale) })}
        </small>
      )}
      {quote.external && reserve == null && amount != null && (
        <small>{h('providerEstimateOnly')}</small>
      )}
    </div>
  );
}

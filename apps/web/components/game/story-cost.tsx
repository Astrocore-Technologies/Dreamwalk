'use client';
import { FundingBreakdown, FundingNotice, type WalletFunding } from '../wallet-funding';
import { formatSparkSubunits, type StoryQuote } from '@dreamwalk/contracts';
import { providerSparkSubunits } from '../visual-authoring/spark-equivalent';
import { useT } from '@/lib/i18n';
import { useImageText } from '../assets/image-messages';
import { useStoryText } from './story-messages';

/** One estimate for the exact prepared message; a wallet hold is not a final debit. */
export function StoryCost({ quote }: { quote: StoryQuote & { funding?: WalletFunding } }) {
  const { locale } = useT();
  const h = useStoryText();
  const g = useImageText();
  const knownImageCost =
    quote.automaticKnownCostPolicy === 'known-cost-v1' &&
    (!quote.generatedLocationImages || quote.automaticKnownCostPolicyHash) ? (
      <p data-image-known-cost-policy>
        {quote.generatedLocationImages
          ? g('automaticKnownCostNotice')
          : h('automaticKnownCostNotice')}
      </p>
    ) : null;
  if (quote.provider === 'local-turn-resolver' && !quote.external && quote.credits === 0)
    return (
      <div data-testid="story-cost">
        <p data-spark-quote-price>{h('worldBatchCost')}</p>
      </div>
    );
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
  const vision = quote.runtimeMapImages ? (
    <small data-runtime-map-consent>
      {locale === 'ru'
        ? 'Изображение текущей карты с видимыми персонажами входит в запрос ИИ. Анализ включён в эту оценку.'
        : locale === 'uk'
          ? 'Зображення поточної мапи з видимими персонажами входить до запиту ШІ. Аналіз включено в цю оцінку.'
          : 'The current map image and visible characters are part of the AI request. Analysis is included in this estimate.'}
    </small>
  ) : null;
  if (
    quote.requiredSparkSubunits !== undefined ||
    (quote.optionalAutonomousSpeechRequests ?? 0) > 0 ||
    quote.optionalAutonomousSpeechSparkSubunits !== undefined
  ) {
    const validSubunits = (value: unknown): value is string =>
      typeof value === 'string' && /^\d+$/.test(value);
    // Legacy world quotes retain the full optional permission envelope. Only
    // subtract exact, validated subunits; never infer required funds from an
    // aggregate provider estimate or rewrite the quote submitted for consent.
    const required = validSubunits(quote.requiredSparkSubunits)
      ? quote.requiredSparkSubunits
      : quote.requiredSparkSubunits === undefined &&
          validSubunits(reserve) &&
          validSubunits(quote.optionalAutonomousSpeechSparkSubunits) &&
          BigInt(reserve) >= BigInt(quote.optionalAutonomousSpeechSparkSubunits)
        ? (BigInt(reserve) - BigInt(quote.optionalAutonomousSpeechSparkSubunits)).toString()
        : null;
    return (
      <div data-testid="story-cost">
        {vision}
        {knownImageCost}
        <p data-world-required-reserve>
          <strong>
            {required !== null
              ? h('worldRequiredReserve', { amount: formatSparkSubunits(required, locale) })
              : h('worldRequiredReserveUnavailable')}
          </strong>
        </p>
        <p>{h('worldRequiredReserveHint')}</p>
        <FundingNotice />
      </div>
    );
  }
  if (quote.funding)
    return (
      <div data-testid="story-cost">
        <FundingBreakdown funding={quote.funding} />
        <FundingNotice />
        {knownImageCost}
        {vision}
      </div>
    );
  return (
    <div data-testid="story-cost">
      {vision}
      {knownImageCost}
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

/** Disclosure precedes the quote action, not just its later generation confirmation. */
export function RuntimeMapQuoteNotice() {
  const { locale } = useT();
  return (
    <small data-runtime-map-quote-notice>
      {locale === 'ru'
        ? 'Для оценки стоимости ИИ может получить текущую карту с видимыми персонажами и подсчитать токены. Ответ начнёт создаваться только после подтверждения.'
        : locale === 'uk'
          ? 'Для оцінки вартості ШІ може отримати поточну мапу з видимими персонажами й підрахувати токени. Відповідь почне створюватися лише після підтвердження.'
          : 'To estimate the cost, the AI may receive the current map and visible characters to count tokens. The response is generated only after confirmation.'}
    </small>
  );
}

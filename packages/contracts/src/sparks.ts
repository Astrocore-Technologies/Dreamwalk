/** Pure proposed fixed-point representation; does not activate billing or convert demo credits. */
export const SPARK_SUBUNITS = 10_000n;
export const MAX_SPARK_SUBUNITS = 9_223_372_036_854_775_807n;
export const LEGACY_SPARK_RATE_VERSION = 'api-cent-1-spark-v1' as const;
export const SPARK_RATE_VERSION = 'api-cent-2-sparks-v2' as const;
export type SparkRateVersion = typeof LEGACY_SPARK_RATE_VERSION | typeof SPARK_RATE_VERSION;
export const SPARK_PACK = Object.freeze({ usdCents: '500', sparkSubunits: '2000000' });

/** Canonical decimal strings survive JSON and PostgreSQL bigint without number coercion. */
export function parseSparkInteger(value: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,18})$/.test(value))
    throw new RangeError('Expected a canonical nonnegative integer string');
  const parsed = BigInt(value);
  if (parsed > MAX_SPARK_SUBUNITS) throw new RangeError('Integer exceeds signed bigint storage');
  return parsed;
}

function checked(value: bigint): string {
  if (value < 0n || value > MAX_SPARK_SUBUNITS)
    throw new RangeError('Amount exceeds signed bigint storage');
  return value.toString();
}

/** Debit conversion only. Provider USD pricing and the wallet denomination stay unchanged. */
export function providerMicrosToSparkSubunits(
  micros: string,
  rateVersion: SparkRateVersion = SPARK_RATE_VERSION,
): string {
  if (rateVersion !== SPARK_RATE_VERSION && rateVersion !== LEGACY_SPARK_RATE_VERSION)
    throw new RangeError('Unsupported Sparks rate version');
  return checked(parseSparkInteger(micros) * (rateVersion === SPARK_RATE_VERSION ? 2n : 1n));
}

export type SparkTariffInput = Readonly<{
  provider: string;
  model: string;
  providerRateVersion: string;
  inputMicrosPerMillion: string;
  cachedInputMicrosPerMillion: string;
  /** Total cache-write rate, not a surcharge. Omit when writes are unpriced/unsupported. */
  cacheWriteMicrosPerMillion?: string;
  outputMicrosPerMillion: string;
}>;

export type SparkTariffSnapshot = SparkTariffInput &
  Readonly<{
    sparkRateVersion: SparkRateVersion;
    currency: 'USD';
    subunitsPerSpark: '10000';
    rounding: 'ceil-total-provider-micro';
    costEvidence: 'reported-tokens-configured-rates';
  }>;

/** Copy primitives and freeze: later config edits cannot mutate an admitted quote's rates. */
export function createSparkTariffSnapshot(
  input: SparkTariffInput & { sparkRateVersion?: SparkRateVersion },
): SparkTariffSnapshot {
  const rateVersion = input.sparkRateVersion ?? SPARK_RATE_VERSION;
  providerMicrosToSparkSubunits('0', rateVersion);
  for (const value of [input.provider, input.model, input.providerRateVersion])
    if (typeof value !== 'string' || !value.trim() || value.length > 200)
      throw new RangeError('Missing or oversized tariff identity');
  return Object.freeze({
    provider: input.provider,
    model: input.model,
    providerRateVersion: input.providerRateVersion,
    inputMicrosPerMillion: parseSparkInteger(input.inputMicrosPerMillion).toString(),
    cachedInputMicrosPerMillion: parseSparkInteger(input.cachedInputMicrosPerMillion).toString(),
    ...(input.cacheWriteMicrosPerMillion === undefined
      ? {}
      : {
          cacheWriteMicrosPerMillion: parseSparkInteger(
            input.cacheWriteMicrosPerMillion,
          ).toString(),
        }),
    outputMicrosPerMillion: parseSparkInteger(input.outputMicrosPerMillion).toString(),
    sparkRateVersion: rateVersion,
    currency: 'USD',
    subunitsPerSpark: '10000',
    rounding: 'ceil-total-provider-micro',
    costEvidence: 'reported-tokens-configured-rates',
  });
}

function verifiedTariff(tariff: SparkTariffSnapshot): SparkTariffSnapshot {
  if (
    (tariff.sparkRateVersion !== SPARK_RATE_VERSION &&
      tariff.sparkRateVersion !== LEGACY_SPARK_RATE_VERSION) ||
    tariff.currency !== 'USD' ||
    tariff.subunitsPerSpark !== '10000' ||
    tariff.rounding !== 'ceil-total-provider-micro' ||
    tariff.costEvidence !== 'reported-tokens-configured-rates'
  )
    throw new RangeError('Unsupported tariff snapshot');
  return createSparkTariffSnapshot(tariff);
}

function cost(numerator: bigint): string {
  // Round once after summing all components, never per token or to whole Sparks.
  return checked((numerator + 999_999n) / 1_000_000n);
}

/**
 * Input includes disjoint ordinary, cache-read and cache-write tokens; output includes reasoning.
 * Omitted write usage preserves the legacy zero-write contract, not evidence a provider did not
 * write. Callers must obtain all applicable usage categories before claiming actual settlement.
 * A mixed-lifetime write total needs an explicitly applicable rate; do not silently use one TTL.
 */
export function actualSparkCost(
  tariff: SparkTariffSnapshot,
  usage: Readonly<{
    inputTokens: string;
    cachedInputTokens: string;
    cacheWriteInputTokens?: string;
    outputTokens: string;
  }>,
): string {
  const rates = verifiedTariff(tariff);
  const input = parseSparkInteger(usage.inputTokens);
  const cached = parseSparkInteger(usage.cachedInputTokens);
  const written = parseSparkInteger(
    usage.cacheWriteInputTokens === undefined ? '0' : usage.cacheWriteInputTokens,
  );
  const output = parseSparkInteger(usage.outputTokens);
  if (cached + written > input) throw new RangeError('Cache reads and writes exceed total input');
  if (written > 0n && rates.cacheWriteMicrosPerMillion === undefined)
    throw new RangeError('Cache-write usage has no immutable price');
  return providerMicrosToSparkSubunits(
    cost(
      (input - cached - written) * BigInt(rates.inputMicrosPerMillion) +
        cached * BigInt(rates.cachedInputMicrosPerMillion) +
        written * BigInt(rates.cacheWriteMicrosPerMillion ?? '0') +
        output * BigInt(rates.outputMicrosPerMillion),
    ),
    rates.sparkRateVersion,
  );
}

/** Reserve using the largest explicitly priced input category; unpriced categories are unsupported. */
export function reserveSparkCost(
  tariff: SparkTariffSnapshot,
  limits: Readonly<{
    inputTokensUpper: string;
    outputTokensMax: string;
  }>,
): string {
  const rates = verifiedTariff(tariff);
  const inputRate = BigInt(rates.inputMicrosPerMillion);
  const cacheRate = BigInt(rates.cachedInputMicrosPerMillion);
  const writeRate = BigInt(rates.cacheWriteMicrosPerMillion ?? '0');
  const maxInputRate = [inputRate, cacheRate, writeRate].reduce((max, rate) =>
    rate > max ? rate : max,
  );
  return providerMicrosToSparkSubunits(
    cost(
      parseSparkInteger(limits.inputTokensUpper) * maxInputRate +
        parseSparkInteger(limits.outputTokensMax) * BigInt(rates.outputMicrosPerMillion),
    ),
    rates.sparkRateVersion,
  );
}

/** Proposed display only, not settlement rounding. Exact mode retains all four decimals. */
export function formatSparkSubunits(
  subunits: string,
  locale: 'en' | 'uk' | 'ru' = 'en',
  precision: 'compact' | 'exact' = 'compact',
): string {
  const value = parseSparkInteger(subunits);
  if (!['en', 'uk', 'ru'].includes(locale) || !['compact', 'exact'].includes(precision))
    throw new RangeError('Unsupported Sparks display option');
  const separator = locale === 'en' ? '.' : ',';
  if (precision === 'compact' && value > 0n && value < 100n) return `<0${separator}01`;
  const units = precision === 'exact' ? value : (value + 50n) / 100n;
  const scale = precision === 'exact' ? 10_000n : 100n;
  const digits = precision === 'exact' ? 4 : 2;
  return `${units / scale}${separator}${(units % scale).toString().padStart(digits, '0')}`;
}

/** Both currencies share pricing, not balances. Quotes estimate; held allocations are exact. */
export interface CurrencyFunding {
  policyVersion: 'dreams-first-v1';
  allocation: 'estimate' | 'reserved';
  dreamsReservedSubunits: string;
  sparksReservedSubunits: string;
  totalReservedSubunits: string;
  maxSparksSubunits: string;
  dreamsCapturedSubunits?: string;
  sparksCapturedSubunits?: string;
}

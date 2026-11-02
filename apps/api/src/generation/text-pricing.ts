/** Explicit Standard-tier tariffs. Cache-write rates are total rates, not surcharges. */
export interface TextCachePricing {
  cachedInputMicrosPerMillion: number;
  cacheWrite30mMicrosPerMillion: number;
  cacheWrite12hMicrosPerMillion: number;
}
export interface TextPricing {
  inputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
  cachePricing?: TextCachePricing;
}
function integer(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('INVALID_TEXT_PRICING');
  return BigInt(value);
}
export function textInputReserveRate(profile: TextPricing): number {
  const rates = [profile.inputMicrosPerMillion, ...Object.values(profile.cachePricing ?? {})];
  rates.forEach(integer);
  return Math.max(...rates);
}
/** Callers with cachePricing must send an explicit implicit/30m request without TTL overrides. */
export function textUsageCostMicros(
  profile: TextPricing,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
    cacheWriteInputTokensDetails?: { ttl30mTokens: number; ttl12hTokens: number };
  },
) {
  const input = integer(usage.inputTokens),
    output = integer(usage.outputTokens);
  const cached = integer(usage.cachedInputTokens ?? 0),
    written = integer(usage.cacheWriteInputTokens ?? 0);
  if (cached + written > input) throw new Error('INVALID_TEXT_CACHE_USAGE');
  const details = usage.cacheWriteInputTokensDetails;
  const write30 = details ? integer(details.ttl30mTokens) : written;
  const write12 = details ? integer(details.ttl12hTokens) : 0n;
  if (write30 + write12 !== written) throw new Error('INVALID_TEXT_CACHE_USAGE');
  const cache = profile.cachePricing;
  const numerator = cache
    ? (input - cached - written) * integer(profile.inputMicrosPerMillion) +
      cached * integer(cache.cachedInputMicrosPerMillion) +
      write30 * integer(cache.cacheWrite30mMicrosPerMillion) +
      write12 * integer(cache.cacheWrite12hMicrosPerMillion) +
      output * integer(profile.outputMicrosPerMillion)
    : input * integer(profile.inputMicrosPerMillion) +
      output * integer(profile.outputMicrosPerMillion);
  const result = (numerator + 999999n) / 1000000n;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('INVALID_TEXT_PRICING');
  return {
    costMicros: Number(result),
    costVerifiedForSparks: !!cache || (cached === 0n && written === 0n),
  };
}

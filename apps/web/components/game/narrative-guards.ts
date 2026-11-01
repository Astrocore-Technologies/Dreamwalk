export type ProviderCostQuote = {
  external?: boolean;
  providerUpperMicros?: number | null;
  providerReserveMicros?: number;
  providerEnforcesQuotedCap?: boolean;
  estimateSnapshot?: {
    schemaVersion: number;
    costBasis: string;
    fingerprint: string;
    reserveMicros: number;
    estimatedTotalMicros: number;
    providerEnforcesQuotedCap: boolean;
  };
};
/** A checked planning reserve permits explicit consent; it never becomes an invoice ceiling. */
export function providerReserveKnown(quote: ProviderCostQuote): boolean {
  const plan = quote.estimateSnapshot;
  return (
    quote.providerUpperMicros === null &&
    quote.providerEnforcesQuotedCap === false &&
    !!plan &&
    plan.schemaVersion === 1 &&
    plan.costBasis === 'operator_estimate' &&
    plan.providerEnforcesQuotedCap === false &&
    /^[a-f0-9]{64}$/.test(plan.fingerprint) &&
    Number.isSafeInteger(plan.estimatedTotalMicros) &&
    plan.estimatedTotalMicros > 0 &&
    Number.isSafeInteger(plan.reserveMicros) &&
    plan.reserveMicros >= plan.estimatedTotalMicros &&
    quote.providerReserveMicros === plan.reserveMicros
  );
}
export function providerBoundKnown(quote: ProviderCostQuote, externalConfigured: boolean): boolean {
  if (!(quote.external ?? externalConfigured)) return true;
  return (
    providerReserveKnown(quote) ||
    (Number.isSafeInteger(quote.providerUpperMicros) && (quote.providerUpperMicros ?? -1) >= 0)
  );
}
export function samePreparedTurn(
  prepared: { text: string; canonRevision: number },
  text: string,
  canonRevision: number,
): boolean {
  return prepared.text === text.trim() && prepared.canonRevision === canonRevision;
}

export function providerBoundKnown(
  quote: { external?: boolean; providerUpperMicros?: number },
  externalConfigured: boolean,
): boolean {
  if (!(quote.external ?? externalConfigured)) return true;
  return Number.isSafeInteger(quote.providerUpperMicros) && (quote.providerUpperMicros ?? -1) >= 0;
}
export function samePreparedTurn(
  prepared: { text: string; canonRevision: number },
  text: string,
  canonRevision: number,
): boolean {
  return prepared.text === text.trim() && prepared.canonRevision === canonRevision;
}

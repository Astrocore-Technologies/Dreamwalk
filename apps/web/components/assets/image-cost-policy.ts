/** Immutable policy returned by the server for this quote, never a client default. */
export type ImageKnownCostSettlement = {
  version: 'known-cost-v1';
  quoteId: string;
  requestHash: string;
  reserveMicros: string;
  costBasis: string;
  knownFailureSettlement: 'capture-verified-cost-release-remainder';
  unknownOrOverrun: 'retain';
  automaticRetry: false;
  fingerprint: string;
};

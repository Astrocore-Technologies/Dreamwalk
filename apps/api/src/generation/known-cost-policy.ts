import { digest } from '../ai/context';

/** Immutable finite batch contents only. No implied authority for future work. */
export function worldKnownCostPolicyHash(entries: unknown[], mediaEntries: unknown[]) {
  return digest({ version: 'known-cost-v1', entries, mediaEntries });
}
export function acceptedWorldKnownCostPolicyMatches(batch: {
  entries?: unknown;
  media_entries?: unknown;
  quote?: { automaticKnownCostPolicy?: unknown; automaticKnownCostPolicyHash?: unknown };
}) {
  return (
    Array.isArray(batch.entries) &&
    Array.isArray(batch.media_entries) &&
    batch.quote?.automaticKnownCostPolicy === 'known-cost-v1' &&
    batch.quote?.automaticKnownCostPolicyHash ===
      worldKnownCostPolicyHash(batch.entries, batch.media_entries)
  );
}

/** A missing aggregate hash cannot downgrade a marked child to legacy consent. */
export function worldKnownCostPolicyRequired(batch: {
  quote?: { automaticKnownCostPolicy?: unknown; automaticKnownCostPolicyHash?: unknown };
  media_entries?: unknown;
}) {
  return !!(
    batch.quote?.automaticKnownCostPolicy ||
    batch.quote?.automaticKnownCostPolicyHash ||
    (Array.isArray(batch.media_entries) &&
      batch.media_entries.some(
        (entry) =>
          entry?.automaticKnownCostPolicyHash ||
          entry?.quote?.automaticKnownCostPolicy ||
          entry?.quote?.automaticKnownCostPolicyHash,
      ))
  );
}

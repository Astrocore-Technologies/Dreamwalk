import {
  readKnownAuthoringSettlement,
  readKnownSettlement,
  type KnownSettlementQuote,
} from './known-npc-settlement';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type OwnerSettlementEntry = {
  holdId: string;
  reservedSubunits: string;
} & (
  | { state: 'active' | 'unavailable' }
  | {
      state: 'verified';
      kind: 'authoring' | 'npc';
      jobId: string;
      campaignId: string | null;
      quote: KnownSettlementQuote;
    }
);
export function readOwnerSettlements(value: unknown, ownerId: string) {
  const data = value as { ownerId?: unknown; entries?: unknown; nextCursor?: unknown } | null;
  if (
    !data ||
    data.ownerId !== ownerId ||
    !Array.isArray(data.entries) ||
    data.entries.length > 10 ||
    !(
      data.nextCursor === null ||
      (typeof data.nextCursor === 'string' && uuid.test(data.nextCursor))
    )
  )
    throw new Error('unavailable');
  const entries: OwnerSettlementEntry[] = data.entries.map((row) => {
    if (
      !row ||
      !uuid.test(row.holdId) ||
      typeof row.reservedSubunits !== 'string' ||
      !/^(0|[1-9][0-9]{0,18})$/.test(row.reservedSubunits) ||
      BigInt(row.reservedSubunits) > 9_223_372_036_854_775_807n
    )
      throw new Error('unavailable');
    const base = { holdId: row.holdId as string, reservedSubunits: row.reservedSubunits as string };
    if (row.state === 'active' || row.state === 'unavailable') return { ...base, state: row.state };
    if (
      row.state !== 'verified' ||
      !uuid.test(row.jobId) ||
      !(row.kind === 'authoring'
        ? row.campaignId === null
        : row.kind === 'npc' && uuid.test(row.campaignId))
    )
      throw new Error('unavailable');
    const quote =
      row.kind === 'authoring'
        ? readKnownAuthoringSettlement(row.quote, row.jobId)
        : readKnownSettlement(row.quote, row.jobId);
    if (
      quote.holdId !== row.holdId ||
      quote.reservedSubunits !== row.reservedSubunits ||
      !['automatic', 'legacy_confirmation'].includes(quote.settlementMode ?? '')
    )
      throw new Error('unavailable');
    return {
      ...base,
      state: 'verified',
      kind: row.kind,
      jobId: row.jobId,
      campaignId: row.campaignId,
      quote,
    };
  });
  if (new Set(entries.map((entry) => entry.holdId)).size !== entries.length)
    throw new Error('unavailable');
  return { entries, nextCursor: data.nextCursor as string | null };
}

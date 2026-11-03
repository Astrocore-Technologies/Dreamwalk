import type { PoolClient } from 'pg';
import type { CurrencyFunding } from '@dreamwalk/contracts';
export const CURRENCY_FUNDING_POLICY = 'dreams-first-v1' as const;
/** Omit absent optional data so an immediate DTO equals its persisted JSON replay. */
export function optionalFunding(funding: CurrencyFunding | undefined): {
  funding?: CurrencyFunding;
} {
  return funding === undefined ? {} : { funding };
}

/** Pure view of the immutable held split, or a clearly marked current-balance estimate. */
export function heldFunding(row: {
  reserved_subunits: string;
  sparks_reserved_subunits?: string | null;
  captured_subunits?: string | null;
}): CurrencyFunding {
  const total = BigInt(row.reserved_subunits),
    sparks = BigInt(row.sparks_reserved_subunits ?? row.reserved_subunits),
    dreams = total - sparks;
  const captured = row.captured_subunits == null ? null : BigInt(row.captured_subunits);
  const dreamCaptured = captured === null ? null : captured < dreams ? captured : dreams;
  return {
    policyVersion: CURRENCY_FUNDING_POLICY,
    allocation: 'reserved',
    totalReservedSubunits: total.toString(),
    dreamsReservedSubunits: dreams.toString(),
    sparksReservedSubunits: sparks.toString(),
    maxSparksSubunits: sparks.toString(),
    ...(captured === null
      ? {}
      : {
          dreamsCapturedSubunits: dreamCaptured!.toString(),
          sparksCapturedSubunits: (captured - dreamCaptured!).toString(),
        }),
  };
}
export async function quoteFunding(
  c: Pick<PoolClient, 'query'>,
  quoteId: string | null | undefined,
): Promise<CurrencyFunding | undefined> {
  if (!quoteId) return undefined;
  const q = (
    await c.query('SELECT owner_id,reserve_subunits,price_snapshot FROM spark_quotes WHERE id=$1', [
      quoteId,
    ])
  ).rows[0];
  if (!q || q.price_snapshot?.fundingPolicy !== CURRENCY_FUNDING_POLICY) return undefined;
  const held = (
    await c.query(
      'SELECT reserved_subunits,sparks_reserved_subunits,captured_subunits FROM spark_holds WHERE id=$1',
      [quoteId],
    )
  ).rows[0];
  if (held) return heldFunding(held);
  const w = (
    await c.query(
      'SELECT balance_subunits,held_subunits FROM dream_wallets WHERE owner_id=$1 AND enabled=true',
      [q.owner_id],
    )
  ).rows[0];
  const total = BigInt(q.reserve_subunits),
    available = w ? BigInt(w.balance_subunits) - BigInt(w.held_subunits) : 0n,
    dreams = available < total ? available : total;
  return {
    policyVersion: CURRENCY_FUNDING_POLICY,
    allocation: 'estimate',
    totalReservedSubunits: total.toString(),
    dreamsReservedSubunits: dreams.toString(),
    sparksReservedSubunits: (total - dreams).toString(),
    maxSparksSubunits: total.toString(),
  };
}
/** Batch children may estimate the same free balance: never sum their Dreams estimates. */
export function aggregateFunding(
  quotes: readonly { funding?: CurrencyFunding }[],
): CurrencyFunding | undefined {
  if (!quotes.length || quotes.some((q) => !q.funding)) return undefined;
  const funds = quotes.map((q) => q.funding!);
  const total = funds.reduce((n, f) => n + BigInt(f.totalReservedSubunits), 0n);
  // Conservative shared-wallet estimate: at most the largest observed free allocation.
  const dreams = funds.reduce(
    (n, f) => (BigInt(f.dreamsReservedSubunits) > n ? BigInt(f.dreamsReservedSubunits) : n),
    0n,
  );
  return {
    policyVersion: CURRENCY_FUNDING_POLICY,
    allocation: 'estimate',
    totalReservedSubunits: total.toString(),
    dreamsReservedSubunits: dreams.toString(),
    sparksReservedSubunits: (total - dreams).toString(),
    maxSparksSubunits: total.toString(),
  };
}

import type { Db } from '../db';

/** Caller has already verified campaign ownership. One read snapshot, no holds
 * or quote writes. Unknown wallet state is never represented as a zero balance. */
export async function readRoundFundingAvailability(db: Pick<Db, 'query'>, ownerId: string) {
  const rows = await db.query(
    `SELECT s.enabled AS sparks_enabled,s.balance_subunits AS sparks_balance,s.held_subunits AS sparks_held,
      d.enabled AS dreams_enabled,d.balance_subunits AS dreams_balance,d.held_subunits AS dreams_held
     FROM spark_wallets s LEFT JOIN dream_wallets d ON d.owner_id=s.owner_id WHERE s.owner_id=$1`,
    [ownerId],
  );
  const row = rows[0];
  if (!row || row.sparks_enabled !== true) return null;
  const available = (enabled: unknown, balance: unknown, held: unknown) => {
    if (!enabled) return 0n;
    if (
      typeof balance !== 'string' ||
      !/^\d+$/.test(balance) ||
      typeof held !== 'string' ||
      !/^\d+$/.test(held)
    )
      return null;
    const value = BigInt(balance) - BigInt(held);
    return value < 0n ? null : value;
  };
  const sparks = available(row.sparks_enabled, row.sparks_balance, row.sparks_held);
  const dreams = available(row.dreams_enabled, row.dreams_balance, row.dreams_held);
  if (sparks === null || dreams === null) return null;
  return {
    sparksSubunits: sparks.toString(),
    dreamsSubunits: dreams.toString(),
    totalSubunits: (sparks + dreams).toString(),
  };
}

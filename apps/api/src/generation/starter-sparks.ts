import type { PoolClient } from 'pg';
import { z } from 'zod';

/** New-account gift, never a backfill. Caller owns the eligibility check and must use
 * the SAME transaction that inserts the user OR consumes their verification eligibility.
 * Verification callers lock the user and clear starter_sparks_eligible atomically.
 * enabled enforces Sparks admission; it does not enable providers, payments or generation policies.
 * Existing wallets are never backfilled, re-enabled or reset by this function.
 */
export async function grantRegistrationSparks(c: PoolClient, ownerId: string) {
  z.uuid().parse(ownerId);
  const created = await c.query(
    'INSERT INTO spark_wallets(owner_id,enabled) VALUES($1,true) ON CONFLICT(owner_id) DO NOTHING RETURNING owner_id',
    [ownerId],
  );
  const eventKey = `starter-grant:v1:${ownerId}`;
  if (!created.rowCount) {
    const previous = await c.query(
      "SELECT id FROM spark_ledger WHERE owner_id=$1 AND kind='starter_grant' AND event_key=$2",
      [ownerId, eventKey],
    );
    if (previous.rowCount) return; // Replay never restores spent credit or changes enabled.
    throw new Error('STARTER_SPARKS_EXISTING_WALLET');
  }
  await c.query(
    `INSERT INTO spark_ledger(owner_id,hold_id,event_key,kind,amount_subunits,evidence)
     VALUES($1,NULL,$2,'starter_grant',500000,'{"source":"registration","version":1}')`,
    [ownerId, eventKey],
  );
  await c.query(
    'UPDATE spark_wallets SET balance_subunits=balance_subunits+500000 WHERE owner_id=$1',
    [ownerId],
  );
}

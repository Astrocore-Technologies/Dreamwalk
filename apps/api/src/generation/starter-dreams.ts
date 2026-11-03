import type { PoolClient } from 'pg';
import { z } from 'zod';

/** Caller owns the registration/verification transaction. No daily or existing-account grants.
 * Eligibility is explicit and defaults false for every pre-existing account.
 * New accounts get a zero Sparks wallet, preserving every existing Sparks row.
 */
export async function grantRegistrationDreams(c: PoolClient, ownerId: string) {
  z.uuid().parse(ownerId);
  const user = (
    await c.query(
      'SELECT starter_dreams_eligible FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',
      [ownerId],
    )
  ).rows[0];
  if (!user?.starter_dreams_eligible) return false;
  const key = `dream-starter:v1:${ownerId}`;
  await c.query(
    'INSERT INTO spark_wallets(owner_id,enabled) VALUES($1,true) ON CONFLICT(owner_id) DO NOTHING',
    [ownerId],
  );
  await c.query(
    'INSERT INTO dream_wallets(owner_id,enabled) VALUES($1,true) ON CONFLICT(owner_id) DO NOTHING',
    [ownerId],
  );
  await c.query('SELECT owner_id FROM dream_wallets WHERE owner_id=$1 FOR UPDATE', [ownerId]);
  const grant = await c.query(
    'INSERT INTO dream_ledger(owner_id,event_key,kind,amount_subunits,evidence) VALUES($1,$2,\'starter_grant\',500000,\'{"source":"registration","version":1}\') ON CONFLICT(event_key) DO NOTHING RETURNING id',
    [ownerId, key],
  );
  if (grant.rowCount)
    await c.query(
      'UPDATE dream_wallets SET balance_subunits=balance_subunits+500000 WHERE owner_id=$1',
      [ownerId],
    );
  await c.query('UPDATE users SET starter_dreams_eligible=false WHERE id=$1', [ownerId]);
  return Boolean(grant.rowCount);
}

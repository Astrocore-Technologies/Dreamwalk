import { z } from 'zod';
import type { Db } from './db';
import { fail } from './errors';

/** Explicit admin issuance only; never converts, debits, or backfills another currency. */
export async function grantAdminDreams(db: Db, actorId: string, body: unknown) {
  const b = z
    .object({
      userId: z.string().uuid(),
      amount: z.number().int().min(1).max(922337203685477),
      reason: z.string().trim().min(3).max(500),
      idempotencyKey: z.string().min(8).max(120),
    })
    .strict()
    .parse(body);
  const delta = BigInt(b.amount) * 10000n;
  const eventKey = `dream-admin-credit:v1:${b.idempotencyKey}`;
  await db.tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [eventKey]);
    const prior = (await c.query('SELECT * FROM dream_ledger WHERE event_key=$1', [eventKey]))
      .rows[0];
    if (prior) {
      if (
        prior.owner_id !== b.userId ||
        prior.kind !== 'admin_credit' ||
        BigInt(prior.amount_subunits) !== delta ||
        prior.evidence.reason !== b.reason ||
        prior.evidence.actorId !== actorId
      )
        fail(409, 'STATE_CONFLICT', 'Ключ операции уже использован с другими данными.');
      return;
    }
    const target = (
      await c.query(
        'SELECT id,starter_sparks_eligible,starter_dreams_eligible FROM users WHERE id=$1 AND deleted_at IS NULL FOR SHARE',
        [b.userId],
      )
    ).rows[0];
    if (!target) fail(404, 'NOT_FOUND', 'Кошелёк не найден.');
    // Keep verification-only gifts separate and do not create a wallet ahead of verification.
    if (target.starter_sparks_eligible || target.starter_dreams_eligible)
      fail(
        409,
        'DREAMS_RECIPIENT_VERIFICATION_REQUIRED',
        'Сначала получатель должен подтвердить почту.',
      );
    await c.query(
      'INSERT INTO dream_wallets(owner_id,enabled) VALUES($1,true) ON CONFLICT(owner_id) DO NOTHING',
      [b.userId],
    );
    const wallet = (
      await c.query('SELECT balance_subunits FROM dream_wallets WHERE owner_id=$1 FOR UPDATE', [
        b.userId,
      ])
    ).rows[0];
    const next = BigInt(wallet.balance_subunits) + delta;
    if (next > 9223372036854775807n)
      fail(409, 'STATE_CONFLICT', 'Баланс превышает допустимую точность.');
    await c.query('UPDATE dream_wallets SET balance_subunits=$2,enabled=true WHERE owner_id=$1', [
      b.userId,
      next.toString(),
    ]);
    const evidence = {
      actorId,
      reason: b.reason,
      amount: b.amount,
      idempotencyKey: b.idempotencyKey,
    };
    await c.query(
      "INSERT INTO dream_ledger(owner_id,event_key,kind,amount_subunits,evidence) VALUES($1,$2,'admin_credit',$3,$4)",
      [b.userId, eventKey, delta.toString(), JSON.stringify(evidence)],
    );
    await c.query(
      "INSERT INTO audit(actor_id,action,target_id,details) VALUES($1,'dreams.credit',$2,$3)",
      [actorId, b.userId, JSON.stringify(evidence)],
    );
  });
  return b.userId;
}

/** Inert accounting primitives. Caller owns a transaction; no provider, credit or activation side effects.
 * No funding or paid-wallet activation path is provided. Existing demo wallets are unrelated.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { parseSparkInteger as parseDreamInteger } from '@dreamwalk/contracts';

const identity = z.string().min(1).max(200);
const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, canonical(x)]),
        )
      : v;
const digest = (v: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(v)))
    .digest('hex');
function reject(code: string): never {
  throw new Error(code);
}

export interface DreamQuoteInput {
  ownerId: string;
  operationId: string;
  sourceKind: 'npc' | 'text' | 'image' | 'translation';
  sourceId: string;
  reserveSubunits: string;
  expiresAt: string;
  /** Full immutable provider quote, including exact image rates when applicable. */
  providerQuote: Record<string, unknown>;
  /** Explicit versioned policy, supplied by trusted server code, never inferred from USD. */
  policyVersion: string;
}
export type DreamSettlement =
  | {
      outcome: 'success';
      actualSubunits: string;
      policyVersion: string;
      evidence: 'reported' | 'configured_rates';
      receiptId: string;
    }
  | { outcome: 'not_dispatched' | 'application_cache'; receiptId: string }
  | { outcome: 'unknown' | 'failure_policy_pending'; receiptId: string };
const settlementSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('success'),
      actualSubunits: z.string(),
      policyVersion: identity,
      evidence: z.enum(['reported', 'configured_rates']),
      receiptId: identity,
    })
    .strict(),
  z
    .object({
      outcome: z.enum(['not_dispatched', 'application_cache', 'unknown', 'failure_policy_pending']),
      receiptId: identity,
    })
    .strict(),
]);
export interface DreamHold {
  id: string;
  owner_id: string;
  source_kind: string;
  source_id: string;
  reserved_subunits: string;
  captured_subunits: string | null;
  status: 'held' | 'pending' | 'settled' | 'released';
  settlement_fingerprint: string | null;
  policy_version: string;
}

/** Pure transition plan permits testing all failure boundaries without a live ledger. */
export function planDreamSettlement(
  hold: DreamHold,
  settlement: DreamSettlement,
  reconciliation = false,
) {
  settlement = settlementSchema.parse(settlement);
  if (settlement.outcome === 'success' && settlement.policyVersion !== hold.policy_version)
    reject('DREAM_SETTLEMENT_POLICY_CONFLICT');
  const reserve = parseDreamInteger(hold.reserved_subunits);
  identity.parse(settlement.receiptId);
  const fingerprint = digest(settlement);
  if (hold.status === 'settled' || hold.status === 'released') {
    if (hold.settlement_fingerprint !== fingerprint) reject('DREAM_SETTLEMENT_CONFLICT');
    return { duplicate: true as const, fingerprint };
  }
  if (
    hold.status === 'pending' &&
    !reconciliation &&
    !['unknown', 'failure_policy_pending'].includes(settlement.outcome)
  )
    reject('DREAM_RECONCILIATION_REQUIRED');
  if (settlement.outcome === 'unknown' || settlement.outcome === 'failure_policy_pending')
    return {
      duplicate: false as const,
      fingerprint,
      pending: true as const,
      reason: settlement.outcome,
    };
  identity.parse(hold.policy_version);
  const actual =
    settlement.outcome === 'success' ? parseDreamInteger(settlement.actualSubunits) : 0n;
  if (actual > reserve)
    return {
      duplicate: false as const,
      fingerprint,
      pending: true as const,
      reason: 'reserve_exceeded',
    };
  return {
    duplicate: false as const,
    fingerprint,
    pending: false as const,
    captured: actual.toString(),
    released: (reserve - actual).toString(),
  };
}

/** Policy identity is immutable; this module does not define rates, routing or eligibility. */
export function dreamQuotePolicy(snapshot: unknown): string {
  return identity.parse((snapshot as { policyVersion?: unknown } | null)?.policyVersion);
}

export class DreamsAccounting {
  /** Disabled and zero by construction; never copies credits or an assumed purchased value. */
  async ensureWallet(c: PoolClient, ownerId: string) {
    z.uuid().parse(ownerId);
    await c.query(
      'INSERT INTO dream_wallets(owner_id) VALUES($1) ON CONFLICT(owner_id) DO NOTHING',
      [ownerId],
    );
  }
  async quote(c: PoolClient, input: DreamQuoteInput) {
    z.uuid().parse(input.ownerId);
    z.uuid().parse(input.operationId);
    z.enum(['npc', 'text', 'image', 'translation']).parse(input.sourceKind);
    identity.parse(input.sourceId);
    const reserve = parseDreamInteger(input.reserveSubunits).toString();
    const expiry = new Date(input.expiresAt);
    if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now())
      reject('DREAM_QUOTE_EXPIRED');
    const policyVersion = identity.parse(input.policyVersion);
    z.record(z.string(), z.unknown()).parse(input.providerQuote);
    const priceSnapshot = JSON.parse(
      JSON.stringify({ currency: 'dreams', policyVersion, providerQuote: input.providerQuote }),
    );
    if (Buffer.byteLength(JSON.stringify(priceSnapshot)) > 64000) reject('DREAM_QUOTE_TOO_LARGE');
    const requestHash = digest({
      ...input,
      policyVersion,
      reserveSubunits: reserve,
      expiresAt: expiry.toISOString(),
    });
    // Same wallet lock serializes quotes, reservations and settlement for one payer.
    const wallet = (
      await c.query('SELECT * FROM dream_wallets WHERE owner_id=$1 FOR UPDATE', [input.ownerId])
    ).rows[0];
    if (!wallet?.enabled) reject('DREAM_WALLET_DISABLED');
    const prior = (
      await c.query('SELECT * FROM dream_quotes WHERE owner_id=$1 AND operation_id=$2', [
        input.ownerId,
        input.operationId,
      ])
    ).rows[0];
    if (prior) {
      if (prior.request_hash !== requestHash) reject('DREAM_IDEMPOTENCY_CONFLICT');
      return prior;
    }
    return (
      await c.query(
        'INSERT INTO dream_quotes(id,owner_id,operation_id,request_hash,source_kind,source_id,price_snapshot,reserve_subunits,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
        [
          randomUUID(),
          input.ownerId,
          input.operationId,
          requestHash,
          input.sourceKind,
          input.sourceId,
          JSON.stringify(priceSnapshot),
          reserve,
          expiry,
        ],
      )
    ).rows[0];
  }
  async reserve(c: PoolClient, ownerId: string, quoteId: string) {
    z.uuid().parse(ownerId);
    z.uuid().parse(quoteId);
    const wallet = (
      await c.query('SELECT * FROM dream_wallets WHERE owner_id=$1 FOR UPDATE', [ownerId])
    ).rows[0];
    const quote = (
      await c.query('SELECT * FROM dream_quotes WHERE id=$1 AND owner_id=$2', [quoteId, ownerId])
    ).rows[0];
    if (!quote) reject('DREAM_QUOTE_NOT_FOUND');
    const prior = (
      await c.query<DreamHold>('SELECT * FROM dream_holds WHERE id=$1 AND owner_id=$2', [
        quoteId,
        ownerId,
      ])
    ).rows[0];
    if (prior) return prior;
    if (!wallet?.enabled) reject('DREAM_WALLET_DISABLED');
    dreamQuotePolicy(quote.price_snapshot);
    if (new Date(quote.expires_at).getTime() <= Date.now()) reject('DREAM_QUOTE_EXPIRED');
    const reserve = parseDreamInteger(String(quote.reserve_subunits));
    const available =
      parseDreamInteger(String(wallet.balance_subunits)) -
      parseDreamInteger(String(wallet.held_subunits));
    if (reserve > available) reject('INSUFFICIENT_DREAMS');
    const duplicateSource = (
      await c.query(
        'SELECT id FROM dream_holds WHERE owner_id=$1 AND source_kind=$2 AND source_id=$3',
        [ownerId, quote.source_kind, quote.source_id],
      )
    ).rows[0];
    if (duplicateSource) reject('DREAM_SOURCE_ALREADY_RESERVED');
    const hold = (
      await c.query<DreamHold>(
        "INSERT INTO dream_holds(id,owner_id,source_kind,source_id,reserved_subunits,status) VALUES($1,$2,$3,$4,$5,'held') RETURNING *",
        [quoteId, ownerId, quote.source_kind, quote.source_id, reserve.toString()],
      )
    ).rows[0];
    await c.query('UPDATE dream_wallets SET held_subunits=held_subunits+$2 WHERE owner_id=$1', [
      ownerId,
      reserve.toString(),
    ]);
    await c.query(
      "INSERT INTO dream_ledger(owner_id,hold_id,event_key,kind,amount_subunits) VALUES($1,$2,$3,'reserve',$4)",
      [ownerId, quoteId, `reserve:${quoteId}`, reserve.toString()],
    );
    return hold;
  }
  async settle(
    c: PoolClient,
    ownerId: string,
    holdId: string,
    settlement: DreamSettlement,
    reconciliation = false,
  ) {
    z.uuid().parse(ownerId);
    z.uuid().parse(holdId);
    await c.query('SELECT owner_id FROM dream_wallets WHERE owner_id=$1 FOR UPDATE', [ownerId]);
    const hold = (
      await c.query<DreamHold>('SELECT * FROM dream_holds WHERE id=$1 AND owner_id=$2 FOR UPDATE', [
        holdId,
        ownerId,
      ])
    ).rows[0];
    if (!hold) reject('DREAM_HOLD_NOT_FOUND');
    // The immutable quote is the rate binding for its hold, including pre-upgrade work.
    const quote = (
      await c.query('SELECT price_snapshot FROM dream_quotes WHERE id=$1 AND owner_id=$2', [
        holdId,
        ownerId,
      ])
    ).rows[0];
    const policyVersion = dreamQuotePolicy(quote?.price_snapshot);
    const plan = planDreamSettlement(
      { ...hold, policy_version: policyVersion },
      settlement,
      reconciliation,
    );
    if (plan.duplicate) return hold;
    if (plan.pending) {
      await c.query("UPDATE dream_holds SET status='pending',reason=$2 WHERE id=$1", [
        holdId,
        plan.reason,
      ]);
      await c.query(
        "INSERT INTO dream_ledger(owner_id,hold_id,event_key,kind,amount_subunits,evidence) VALUES($1,$2,$3,'pending',$4,$5) ON CONFLICT(event_key) DO NOTHING",
        [
          ownerId,
          holdId,
          `pending:${holdId}:${plan.fingerprint}`,
          hold.reserved_subunits,
          JSON.stringify(settlement),
        ],
      );
    } else {
      await c.query(
        'UPDATE dream_wallets SET held_subunits=held_subunits-$2,balance_subunits=balance_subunits-$3 WHERE owner_id=$1',
        [ownerId, hold.reserved_subunits, plan.captured],
      );
      await c.query(
        'UPDATE dream_holds SET status=$2,captured_subunits=$3,settlement_fingerprint=$4,settled_at=now(),reason=NULL WHERE id=$1',
        [holdId, plan.captured === '0' ? 'released' : 'settled', plan.captured, plan.fingerprint],
      );
      for (const [kind, amount] of [
        ['capture', plan.captured],
        ['release', plan.released],
      ])
        await c.query(
          'INSERT INTO dream_ledger(owner_id,hold_id,event_key,kind,amount_subunits,evidence) VALUES($1,$2,$3,$4,$5,$6)',
          [ownerId, holdId, `${kind}:${holdId}`, kind, amount, JSON.stringify(settlement)],
        );
    }
    return (
      await c.query<DreamHold>('SELECT * FROM dream_holds WHERE id=$1 AND owner_id=$2', [
        holdId,
        ownerId,
      ])
    ).rows[0];
  }
}

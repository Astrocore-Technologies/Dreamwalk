/** Inert accounting primitives. Caller owns a transaction; no provider, credit or activation side effects.
 * No funding or paid-wallet activation path is provided. Existing demo wallets are unrelated.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  actualSparkCost,
  createSparkTariffSnapshot,
  parseSparkInteger,
  providerMicrosToSparkSubunits,
  type SparkTariffSnapshot,
  type SparkRateVersion,
} from '@dreamwalk/contracts';

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

export interface SparkQuoteInput {
  ownerId: string;
  operationId: string;
  sourceKind: 'npc' | 'text' | 'image';
  sourceId: string;
  reserveSubunits: string;
  expiresAt: string;
  /** Full immutable provider quote, including exact image rates when applicable. */
  providerQuote: Record<string, unknown>;
  tariff: SparkTariffSnapshot;
}
export type SparkSettlement =
  | {
      outcome: 'success';
      actualMicros: string;
      evidence: 'reported' | 'configured_rates';
      receiptId: string;
    }
  | { outcome: 'not_dispatched' | 'application_cache'; receiptId: string }
  | { outcome: 'unknown' | 'failure_policy_pending'; receiptId: string };
const settlementSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('success'),
      actualMicros: z.string(),
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
export interface SparkHold {
  id: string;
  owner_id: string;
  source_kind: string;
  source_id: string;
  reserved_subunits: string;
  captured_subunits: string | null;
  status: 'held' | 'pending' | 'settled' | 'released';
  settlement_fingerprint: string | null;
  spark_rate_version: SparkRateVersion;
}

/** Derive settlement using the admitted tariff, never today's mutable pricing configuration. */
export function sparkTextActual(
  tariff: SparkTariffSnapshot,
  usage: {
    inputTokens: string;
    cachedInputTokens: string;
    outputTokens: string;
  },
) {
  return actualSparkCost(tariff, usage);
}

/** Pure transition plan permits testing all failure boundaries without a live ledger. */
export function planSparkSettlement(
  hold: SparkHold,
  settlement: SparkSettlement,
  reconciliation = false,
) {
  settlement = settlementSchema.parse(settlement);
  const reserve = parseSparkInteger(hold.reserved_subunits);
  identity.parse(settlement.receiptId);
  const fingerprint = digest(settlement);
  if (hold.status === 'settled' || hold.status === 'released') {
    if (hold.settlement_fingerprint !== fingerprint) reject('SPARK_SETTLEMENT_CONFLICT');
    return { duplicate: true as const, fingerprint };
  }
  if (
    hold.status === 'pending' &&
    !reconciliation &&
    !['unknown', 'failure_policy_pending'].includes(settlement.outcome)
  )
    reject('SPARK_RECONCILIATION_REQUIRED');
  if (settlement.outcome === 'unknown' || settlement.outcome === 'failure_policy_pending')
    return {
      duplicate: false as const,
      fingerprint,
      pending: true as const,
      reason: settlement.outcome,
    };
  if (!hold.spark_rate_version) reject('SPARK_QUOTE_RATE_UNSUPPORTED');
  const actual =
    settlement.outcome === 'success'
      ? parseSparkInteger(
          providerMicrosToSparkSubunits(settlement.actualMicros, hold.spark_rate_version),
        )
      : 0n;
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

/** No guessing: an absent/unknown binding must be re-quoted or reconciled explicitly. */
export function sparkQuoteRateVersion(snapshot: unknown): SparkRateVersion {
  const version = (snapshot as { tariff?: { sparkRateVersion?: SparkRateVersion } } | null)?.tariff
    ?.sparkRateVersion;
  if (!version) reject('SPARK_QUOTE_RATE_UNSUPPORTED');
  try {
    providerMicrosToSparkSubunits('0', version);
  } catch {
    reject('SPARK_QUOTE_RATE_UNSUPPORTED');
  }
  return version;
}

export class SparksAccounting {
  /** Disabled and zero by construction; never copies credits or an assumed purchased value. */
  async ensureWallet(c: PoolClient, ownerId: string) {
    z.uuid().parse(ownerId);
    await c.query(
      'INSERT INTO spark_wallets(owner_id) VALUES($1) ON CONFLICT(owner_id) DO NOTHING',
      [ownerId],
    );
  }
  async quote(c: PoolClient, input: SparkQuoteInput) {
    z.uuid().parse(input.ownerId);
    z.uuid().parse(input.operationId);
    z.enum(['npc', 'text', 'image']).parse(input.sourceKind);
    identity.parse(input.sourceId);
    const reserve = parseSparkInteger(input.reserveSubunits).toString();
    const expiry = new Date(input.expiresAt);
    if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now())
      reject('SPARK_QUOTE_EXPIRED');
    actualSparkCost(input.tariff, { inputTokens: '0', cachedInputTokens: '0', outputTokens: '0' });
    const tariff = createSparkTariffSnapshot(input.tariff);
    z.record(z.string(), z.unknown()).parse(input.providerQuote);
    const priceSnapshot = JSON.parse(
      JSON.stringify({ tariff, providerQuote: input.providerQuote }),
    );
    if (Buffer.byteLength(JSON.stringify(priceSnapshot)) > 64000) reject('SPARK_QUOTE_TOO_LARGE');
    const requestHash = digest({
      ...input,
      tariff,
      reserveSubunits: reserve,
      expiresAt: expiry.toISOString(),
    });
    // Same wallet lock serializes quotes, reservations and settlement for one payer.
    const wallet = (
      await c.query('SELECT * FROM spark_wallets WHERE owner_id=$1 FOR UPDATE', [input.ownerId])
    ).rows[0];
    if (!wallet?.enabled) reject('SPARK_WALLET_DISABLED');
    const prior = (
      await c.query('SELECT * FROM spark_quotes WHERE owner_id=$1 AND operation_id=$2', [
        input.ownerId,
        input.operationId,
      ])
    ).rows[0];
    if (prior) {
      if (prior.request_hash !== requestHash) reject('SPARK_IDEMPOTENCY_CONFLICT');
      return prior;
    }
    return (
      await c.query(
        'INSERT INTO spark_quotes(id,owner_id,operation_id,request_hash,source_kind,source_id,price_snapshot,reserve_subunits,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
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
      await c.query('SELECT * FROM spark_wallets WHERE owner_id=$1 FOR UPDATE', [ownerId])
    ).rows[0];
    const quote = (
      await c.query('SELECT * FROM spark_quotes WHERE id=$1 AND owner_id=$2', [quoteId, ownerId])
    ).rows[0];
    if (!quote) reject('SPARK_QUOTE_NOT_FOUND');
    const prior = (
      await c.query<SparkHold>('SELECT * FROM spark_holds WHERE id=$1 AND owner_id=$2', [
        quoteId,
        ownerId,
      ])
    ).rows[0];
    if (prior) return prior;
    if (!wallet?.enabled) reject('SPARK_WALLET_DISABLED');
    sparkQuoteRateVersion(quote.price_snapshot);
    if (new Date(quote.expires_at).getTime() <= Date.now()) reject('SPARK_QUOTE_EXPIRED');
    const reserve = parseSparkInteger(String(quote.reserve_subunits));
    const available =
      parseSparkInteger(String(wallet.balance_subunits)) -
      parseSparkInteger(String(wallet.held_subunits));
    if (reserve > available) reject('INSUFFICIENT_SPARKS');
    const duplicateSource = (
      await c.query(
        'SELECT id FROM spark_holds WHERE owner_id=$1 AND source_kind=$2 AND source_id=$3',
        [ownerId, quote.source_kind, quote.source_id],
      )
    ).rows[0];
    if (duplicateSource) reject('SPARK_SOURCE_ALREADY_RESERVED');
    const hold = (
      await c.query<SparkHold>(
        "INSERT INTO spark_holds(id,owner_id,source_kind,source_id,reserved_subunits,status) VALUES($1,$2,$3,$4,$5,'held') RETURNING *",
        [quoteId, ownerId, quote.source_kind, quote.source_id, reserve.toString()],
      )
    ).rows[0];
    await c.query('UPDATE spark_wallets SET held_subunits=held_subunits+$2 WHERE owner_id=$1', [
      ownerId,
      reserve.toString(),
    ]);
    await c.query(
      "INSERT INTO spark_ledger(owner_id,hold_id,event_key,kind,amount_subunits) VALUES($1,$2,$3,'reserve',$4)",
      [ownerId, quoteId, `reserve:${quoteId}`, reserve.toString()],
    );
    return hold;
  }
  async settle(
    c: PoolClient,
    ownerId: string,
    holdId: string,
    settlement: SparkSettlement,
    reconciliation = false,
  ) {
    z.uuid().parse(ownerId);
    z.uuid().parse(holdId);
    await c.query('SELECT owner_id FROM spark_wallets WHERE owner_id=$1 FOR UPDATE', [ownerId]);
    const hold = (
      await c.query<SparkHold>('SELECT * FROM spark_holds WHERE id=$1 AND owner_id=$2 FOR UPDATE', [
        holdId,
        ownerId,
      ])
    ).rows[0];
    if (!hold) reject('SPARK_HOLD_NOT_FOUND');
    // The immutable quote is the rate binding for its hold, including pre-upgrade work.
    const quote = (
      await c.query('SELECT price_snapshot FROM spark_quotes WHERE id=$1 AND owner_id=$2', [
        holdId,
        ownerId,
      ])
    ).rows[0];
    const rateVersion = sparkQuoteRateVersion(quote?.price_snapshot);
    const plan = planSparkSettlement(
      { ...hold, spark_rate_version: rateVersion },
      settlement,
      reconciliation,
    );
    if (plan.duplicate) return hold;
    if (plan.pending) {
      await c.query("UPDATE spark_holds SET status='pending',reason=$2 WHERE id=$1", [
        holdId,
        plan.reason,
      ]);
      await c.query(
        "INSERT INTO spark_ledger(owner_id,hold_id,event_key,kind,amount_subunits,evidence) VALUES($1,$2,$3,'pending',$4,$5) ON CONFLICT(event_key) DO NOTHING",
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
        'UPDATE spark_wallets SET held_subunits=held_subunits-$2,balance_subunits=balance_subunits-$3 WHERE owner_id=$1',
        [ownerId, hold.reserved_subunits, plan.captured],
      );
      await c.query(
        'UPDATE spark_holds SET status=$2,captured_subunits=$3,settlement_fingerprint=$4,settled_at=now(),reason=NULL WHERE id=$1',
        [holdId, plan.captured === '0' ? 'released' : 'settled', plan.captured, plan.fingerprint],
      );
      for (const [kind, amount] of [
        ['capture', plan.captured],
        ['release', plan.released],
      ])
        await c.query(
          'INSERT INTO spark_ledger(owner_id,hold_id,event_key,kind,amount_subunits,evidence) VALUES($1,$2,$3,$4,$5,$6)',
          [ownerId, holdId, `${kind}:${holdId}`, kind, amount, JSON.stringify(settlement)],
        );
    }
    return (
      await c.query<SparkHold>('SELECT * FROM spark_holds WHERE id=$1 AND owner_id=$2', [
        holdId,
        ownerId,
      ])
    ).rows[0];
  }
}

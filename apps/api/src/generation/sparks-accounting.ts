import { readAutonomousSpeechBoundEntry } from './autonomous-speech-envelope';
import {
  acceptedWorldKnownCostPolicyMatches,
  worldKnownCostPolicyRequired,
} from './known-cost-policy';
import { verifyAcceptedTravelBatch, type AcceptedTravelBatchProof } from './travel-consent';
/** Inert accounting primitives. Caller owns a transaction; no provider, credit or activation side effects.
 * No funding or paid-wallet activation path is provided. Existing demo wallets are unrelated.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { matchesTurnFence } from '@dreamwalk/game-core';
import { DreamsAccounting } from './dreams-accounting';
const dreamsAccounting = new DreamsAccounting();
export const DREAMS_FIRST_POLICY = 'dreams-first-v1';
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

/** Server-only identifiers, not a trust flag. Both admission and accounting verify
 * the durable, finite consent independently against locked authoritative rows. */
export interface AcceptedWorldBatchProof {
  automaticKnownCostPolicy?: 'known-cost-v1';
  batchId: string;
  nativeQuoteId: string;
  runtimeRequestId: string;
  contextDigest: string;
  campaignId: string;
  providerId: string;
  providerVersion: string;
  policyVersion: string;
}
export async function verifyAcceptedWorldBatch(
  c: PoolClient,
  ownerId: string,
  proof: AcceptedWorldBatchProof,
  sparkQuoteId?: string,
): Promise<void> {
  z.uuid().parse(proof.batchId);
  const batch = (
    await c.query('SELECT * FROM game_world_generation_batches WHERE id=$1 FOR UPDATE', [
      proof.batchId,
    ])
  ).rows[0];
  const request = (
    await c.query('SELECT * FROM game_npc_decision_requests WHERE id=$1 FOR UPDATE', [
      proof.runtimeRequestId,
    ])
  ).rows[0];
  const native = (
    await c.query('SELECT * FROM npc_ai_quotes WHERE id=$1 FOR UPDATE', [proof.nativeQuoteId])
  ).rows[0];
  const campaign = (
    await c.query(
      'SELECT state,status,owner_id,source_version_id FROM game_campaigns WHERE id=$1 FOR SHARE',
      [proof.campaignId],
    )
  ).rows[0];
  const entries = Array.isArray(batch?.entries) ? batch.entries : [];
  const matches = entries.filter(
    (entry: { requestId: string; quote: { id: string } }) =>
      entry.requestId === proof.runtimeRequestId && entry.quote?.id === proof.nativeQuoteId,
  );
  const child =
    matches.length === 0 && batch && request && native
      ? await readAutonomousSpeechBoundEntry(c, batch, request, native)
      : undefined;
  if (child) matches.push(child);
  const entry = matches[0];
  const acceptedAt = batch?.accepted_at ? new Date(batch.accepted_at).getTime() : NaN;
  if (
    !batch ||
    ((proof.automaticKnownCostPolicy === 'known-cost-v1' || worldKnownCostPolicyRequired(batch)) &&
      !acceptedWorldKnownCostPolicyMatches(batch)) ||
    batch.state !== 'accepted' ||
    !Number.isFinite(acceptedAt) ||
    !(acceptedAt < new Date(batch.expires_at).getTime()) ||
    batch.owner_id !== ownerId ||
    batch.campaign_id !== proof.campaignId ||
    matches.length !== 1 ||
    !request ||
    request.status !== 'queued' ||
    request.job_id ||
    request.campaign_id !== proof.campaignId ||
    request.requester_user_id !== ownerId ||
    request.npc_id !== entry.npcId ||
    request.purpose !== entry.purpose ||
    entry.contextDigest !== proof.contextDigest ||
    digest(request.context) !== proof.contextDigest ||
    !native ||
    native.user_id !== ownerId ||
    native.campaign_id !== proof.campaignId ||
    native.npc_id !== request.npc_id ||
    native.purpose !== request.purpose ||
    native.context_hash !== request.context.contextHash ||
    native.provider_id !== proof.providerId ||
    native.provider_version !== proof.providerVersion ||
    native.policy_version !== proof.policyVersion ||
    !(acceptedAt < new Date(native.expires_at).getTime()) ||
    !campaign ||
    campaign.status !== 'active' ||
    campaign.owner_id !== ownerId ||
    (child && campaign.source_version_id !== child.sourceVersionId) ||
    campaign.state?.turnController?.phase !== 'world' ||
    !matchesTurnFence(campaign.state, batch.turn_fence)
  )
    reject('WORLD_BATCH_CONSENT_STALE');
  if (
    (await c.query('SELECT 1 FROM npc_ai_jobs WHERE quote_id=$1', [proof.nativeQuoteId])).rowCount
  )
    reject('QUOTE_CONSUMED');
  if (
    (
      await c.query(
        `SELECT 1 FROM npc_ai_jobs j LEFT JOIN spark_holds h ON h.id=j.spark_hold_id
      WHERE j.campaign_id=$1 AND (j.status='reconciling' OR h.status='pending')
      UNION ALL SELECT 1 FROM live_test_text_permits WHERE campaign_id=$1 AND state='unknown' LIMIT 1`,
        [proof.campaignId],
      )
    ).rowCount
  )
    reject('LIVE_OUTCOME_UNRESOLVED');
  if (sparkQuoteId) {
    const spark = (
      await c.query('SELECT * FROM spark_quotes WHERE id=$1 AND owner_id=$2', [
        sparkQuoteId,
        ownerId,
      ])
    ).rows[0];
    if (
      !spark ||
      native.spark_quote_id !== sparkQuoteId ||
      (child &&
        (String(spark.reserve_subunits) !== String(child.quote.sparkReservedSubunits) ||
          spark.price_snapshot?.tariff?.sparkRateVersion !== child.quote.sparkRateVersion)) ||
      spark.source_kind !== 'npc' ||
      spark.source_id !== native.id ||
      spark.operation_id !== native.id ||
      !(acceptedAt < new Date(spark.expires_at).getTime()) ||
      digest(spark.price_snapshot?.providerQuote) !==
        digest({
          ...native.request_snapshot,
          policyVersion: native.policy_version,
          contextHash: native.context_hash,
          ...(spark.price_snapshot?.providerQuote?.automaticKnownCostPolicy === 'known-cost-v1'
            ? { automaticKnownCostPolicy: 'known-cost-v1' }
            : {}),
        })
    )
      reject('WORLD_BATCH_CONSENT_STALE');
  }
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
  dream_hold_id?: string | null;
  sparks_reserved_subunits?: string | null;
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
      JSON.stringify({
        tariff,
        providerQuote: input.providerQuote,
        fundingPolicy: DREAMS_FIRST_POLICY,
      }),
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
  async reserve(
    c: PoolClient,
    ownerId: string,
    quoteId: string,
    worldBatch?: AcceptedWorldBatchProof | AcceptedTravelBatchProof,
  ) {
    z.uuid().parse(ownerId);
    z.uuid().parse(quoteId);
    if (worldBatch) {
      if ('preparationId' in worldBatch)
        await verifyAcceptedTravelBatch(c, ownerId, worldBatch, quoteId);
      else await verifyAcceptedWorldBatch(c, ownerId, worldBatch, quoteId);
    }
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
    if (!worldBatch && new Date(quote.expires_at).getTime() <= Date.now())
      reject('SPARK_QUOTE_EXPIRED');
    const reserve = parseSparkInteger(String(quote.reserve_subunits));
    const dreamWallet =
      quote.price_snapshot?.fundingPolicy === DREAMS_FIRST_POLICY
        ? (await c.query('SELECT * FROM dream_wallets WHERE owner_id=$1 FOR UPDATE', [ownerId]))
            .rows[0]
        : null;
    const dreamAvailable = dreamWallet?.enabled
      ? BigInt(dreamWallet.balance_subunits) - BigInt(dreamWallet.held_subunits)
      : 0n;
    const dreamReserve = dreamAvailable < reserve ? dreamAvailable : reserve;
    const sparkReserve = reserve - dreamReserve;
    const available =
      parseSparkInteger(String(wallet.balance_subunits)) -
      parseSparkInteger(String(wallet.held_subunits));
    if (sparkReserve > available) reject('INSUFFICIENT_SPARKS');
    const duplicateSource = (
      await c.query(
        'SELECT id FROM spark_holds WHERE owner_id=$1 AND source_kind=$2 AND source_id=$3',
        [ownerId, quote.source_kind, quote.source_id],
      )
    ).rows[0];
    if (duplicateSource) reject('SPARK_SOURCE_ALREADY_RESERVED');
    let dreamHoldId: string | null = null;
    if (dreamReserve > 0n) {
      const dreamQuote = await dreamsAccounting.quote(c, {
        ownerId,
        operationId: quoteId,
        sourceKind: quote.source_kind,
        sourceId: quote.source_id,
        reserveSubunits: dreamReserve.toString(),
        // Internal funding split only; the original accepted price and quote stay immutable.
        expiresAt: worldBatch
          ? new Date(Date.now() + 60000).toISOString()
          : new Date(quote.expires_at).toISOString(),
        policyVersion: DREAMS_FIRST_POLICY,
        providerQuote: { sparkQuoteId: quoteId, priceSnapshot: quote.price_snapshot },
      });
      dreamHoldId = (await dreamsAccounting.reserve(c, ownerId, dreamQuote.id)).id;
    }
    const hold = (
      await c.query<SparkHold>(
        "INSERT INTO spark_holds(id,owner_id,source_kind,source_id,reserved_subunits,status,dream_hold_id,sparks_reserved_subunits) VALUES($1,$2,$3,$4,$5,'held',$6,$7) RETURNING *",
        [
          quoteId,
          ownerId,
          quote.source_kind,
          quote.source_id,
          reserve.toString(),
          dreamHoldId,
          sparkReserve.toString(),
        ],
      )
    ).rows[0];
    await c.query('UPDATE spark_wallets SET held_subunits=held_subunits+$2 WHERE owner_id=$1', [
      ownerId,
      sparkReserve.toString(),
    ]);
    await c.query(
      "INSERT INTO spark_ledger(owner_id,hold_id,event_key,kind,amount_subunits) VALUES($1,$2,$3,'reserve',$4)",
      [ownerId, quoteId, `reserve:${quoteId}`, sparkReserve.toString()],
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
    const sparkReserved = BigInt(hold.sparks_reserved_subunits ?? hold.reserved_subunits);
    const dreamReserved = BigInt(hold.reserved_subunits) - sparkReserved;
    const totalCaptured = plan.pending ? 0n : BigInt(plan.captured);
    const dreamCaptured = totalCaptured < dreamReserved ? totalCaptured : dreamReserved;
    const sparkCaptured = totalCaptured - dreamCaptured;
    if (hold.dream_hold_id)
      await dreamsAccounting.settle(
        c,
        ownerId,
        hold.dream_hold_id,
        plan.pending
          ? { outcome: 'unknown', receiptId: settlement.receiptId }
          : {
              outcome: 'success',
              actualSubunits: dreamCaptured.toString(),
              policyVersion: DREAMS_FIRST_POLICY,
              evidence: 'configured_rates',
              receiptId: settlement.receiptId,
            },
        reconciliation,
      );
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
          sparkReserved.toString(),
          JSON.stringify(settlement),
        ],
      );
    } else {
      await c.query(
        'UPDATE spark_wallets SET held_subunits=held_subunits-$2,balance_subunits=balance_subunits-$3 WHERE owner_id=$1',
        [ownerId, sparkReserved.toString(), sparkCaptured.toString()],
      );
      await c.query(
        'UPDATE spark_holds SET status=$2,captured_subunits=$3,settlement_fingerprint=$4,settled_at=now(),reason=NULL WHERE id=$1',
        [holdId, plan.captured === '0' ? 'released' : 'settled', plan.captured, plan.fingerprint],
      );
      for (const [kind, amount] of [
        ['capture', sparkCaptured.toString()],
        ['release', (sparkReserved - sparkCaptured).toString()],
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

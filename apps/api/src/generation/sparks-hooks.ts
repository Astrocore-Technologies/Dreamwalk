import type { AcceptedTravelBatchProof } from './travel-consent';
import { quoteFunding, optionalFunding } from './currency-funding';
/** Transactional usage accounting: mandatory in release, opt-in for historical modes.
 * No wallet creation, funding or activation. */
import type { PoolClient } from 'pg';
import {
  createSparkTariffSnapshot,
  type SparkTariffSnapshot,
  type CurrencyFunding,
} from '@dreamwalk/contracts';
import {
  SparksAccounting,
  sparkQuoteRateVersion,
  type SparkQuoteInput,
  type SparkSettlement,
} from './sparks-accounting';
import { fail } from '../errors';
import { fenceGenerationAdmission } from './scope-fence';
import type { TextPricing } from './text-pricing';
const accounting = new SparksAccounting();
export async function sparksEnabled(c: PoolClient, ownerId: string) {
  return (
    (await c.query('SELECT enabled FROM spark_wallets WHERE owner_id=$1 FOR UPDATE', [ownerId]))
      .rows[0]?.enabled === true
  );
}
export function sparkTariff(
  profile: TextPricing & { model: string },
  provider: string,
  version: string,
): SparkTariffSnapshot {
  // The full mixed-TTL tariff also lives in the immutable providerQuote snapshot.
  // Legacy profiles do not acquire an invented cache discount/write price.
  return createSparkTariffSnapshot({
    provider,
    model: profile.model,
    providerRateVersion: version,
    inputMicrosPerMillion: String(profile.inputMicrosPerMillion),
    cachedInputMicrosPerMillion: String(
      profile.cachePricing?.cachedInputMicrosPerMillion ?? profile.inputMicrosPerMillion,
    ),
    ...(profile.cachePricing
      ? { cacheWriteMicrosPerMillion: String(profile.cachePricing.cacheWrite30mMicrosPerMillion) }
      : {}),
    outputMicrosPerMillion: String(profile.outputMicrosPerMillion),
  });
}
export async function quoteSparks(
  c: PoolClient,
  input: SparkQuoteInput,
  options: { required?: boolean } = {},
) {
  if (!(await sparksEnabled(c, input.ownerId))) {
    if (options.required) fail(409, 'SPARK_WALLET_NOT_ENABLED', 'SPARK_WALLET_NOT_ENABLED');
    return null;
  }
  const wallet = (
    await c.query('SELECT balance_subunits,held_subunits FROM spark_wallets WHERE owner_id=$1', [
      input.ownerId,
    ])
  ).rows[0];
  const dreams = (
    await c.query(
      'SELECT balance_subunits,held_subunits,enabled FROM dream_wallets WHERE owner_id=$1 FOR UPDATE',
      [input.ownerId],
    )
  ).rows[0];
  const dreamAvailable = dreams?.enabled
    ? BigInt(dreams.balance_subunits) - BigInt(dreams.held_subunits)
    : 0n;
  if (
    BigInt(wallet.balance_subunits) - BigInt(wallet.held_subunits) + dreamAvailable <
    BigInt(input.reserveSubunits)
  )
    fail(409, 'INSUFFICIENT_SPARKS', 'INSUFFICIENT_SPARKS');
  return (await accounting.quote(c, input)).id as string;
}
export async function reserveSparks(
  c: PoolClient,
  ownerId: string,
  quoteId: string | null,
  reservationId: string,
  options: { required?: boolean; acceptedTravel?: AcceptedTravelBatchProof } = {},
) {
  // Defense in depth: a missed caller option must never turn release spending into
  // legacy opt-in accounting. The persisted scope, not request JSON, decides.
  const required =
    options.required ||
    !!(
      await c.query(
        "SELECT 1 FROM generation_budget_reservations r JOIN live_test_sessions s ON s.scope_id=r.scope_id AND s.mode='release' WHERE r.id=$1 AND r.actor_id=$2",
        [reservationId, ownerId],
      )
    ).rowCount;
  if (required && !(await sparksEnabled(c, ownerId)))
    fail(409, 'SPARK_WALLET_NOT_ENABLED', 'SPARK_WALLET_NOT_ENABLED');
  if (!quoteId) {
    if (required) fail(409, 'SPARK_QUOTE_REQUIRED', 'SPARK_QUOTE_REQUIRED');
    if (await sparksEnabled(c, ownerId)) fail(409, 'SPARK_QUOTE_REQUIRED', 'SPARK_QUOTE_REQUIRED');
    return;
  }
  try {
    await accounting.reserve(c, ownerId, quoteId, options.acceptedTravel);
  } catch (error) {
    if (error instanceof Error && /^(INSUFFICIENT_SPARKS|SPARK_[A-Z_]+)$/.test(error.message))
      fail(409, error.message, error.message);
    throw error;
  }
  const linked = await c.query(
    'UPDATE generation_budget_reservations SET spark_quote_id=$2 WHERE id=$1 AND actor_id=$3 AND (spark_quote_id IS NULL OR spark_quote_id=$2)',
    [reservationId, quoteId, ownerId],
  );
  if (linked.rowCount !== 1) fail(409, 'SPARK_RESERVATION_CONFLICT', 'SPARK_RESERVATION_CONFLICT');
}
export async function settleReservationSparks(
  c: PoolClient,
  reservationId: string,
  settlement: SparkSettlement,
) {
  const row = (
    await c.query(
      'SELECT actor_id,spark_quote_id,scope_id FROM generation_budget_reservations WHERE id=$1',
      [reservationId],
    )
  ).rows[0];
  if (!row?.spark_quote_id) return;
  // Authorization/scope precedes the global provider fence, then the wallet. A late
  // callback can settle provider cost after this hook; wallet-before-fence would
  // deadlock against another scope's admission for the same owner.
  await c.query('SELECT id FROM generation_budget_scopes WHERE id=$1 FOR UPDATE', [row.scope_id]);
  await fenceGenerationAdmission(c);
  await c.query('SELECT owner_id FROM spark_wallets WHERE owner_id=$1 FOR UPDATE', [row.actor_id]);
  // Unknown outcomes need explicit reconciliation, not automatic capture from a late receipt.
  const hold = (await c.query('SELECT status FROM spark_holds WHERE id=$1', [row.spark_quote_id]))
    .rows[0];
  // The integration can see several terminal callbacks (cache, semantic finalize, late receipt).
  // Never invent a second capture or rewrite an immutable final hold.
  if (hold?.status === 'settled' || hold?.status === 'released') return;
  if (
    hold?.status === 'pending' &&
    !['unknown', 'failure_policy_pending'].includes(settlement.outcome)
  )
    return;
  return accounting.settle(c, row.actor_id, row.spark_quote_id, settlement);
}
export async function sparkQuoteView(
  c: Pick<PoolClient, 'query'>,
  quoteId: string | null | undefined,
): Promise<{
  funding?: CurrencyFunding;
  sparks?: {
    quoteId: string;
    reserveSubunits: string;
    rateVersion: ReturnType<typeof sparkQuoteRateVersion>;
    walletCharging: true;
  };
}> {
  if (!quoteId) return {};
  const quote = (
    await c.query('SELECT reserve_subunits,price_snapshot FROM spark_quotes WHERE id=$1', [quoteId])
  ).rows[0];
  if (!quote) fail(409, 'SPARK_QUOTE_NOT_FOUND', 'SPARK_QUOTE_NOT_FOUND');
  return {
    ...optionalFunding(await quoteFunding(c, quoteId)),
    sparks: {
      quoteId,
      reserveSubunits: String(quote.reserve_subunits),
      rateVersion: sparkQuoteRateVersion(quote.price_snapshot),
      walletCharging: true as const,
    },
  };
}

export async function sparkHoldView(
  c: Pick<PoolClient, 'query'>,
  quoteId: string | null | undefined,
) {
  if (!quoteId) return {};
  const h = (
    await c.query(
      'SELECT status,reserved_subunits,captured_subunits FROM spark_holds WHERE id=$1',
      [quoteId],
    )
  ).rows[0];
  return h
    ? {
        ...optionalFunding(await quoteFunding(c, quoteId)),
        sparkHoldId: quoteId,
        sparkStatus: h.status,
        sparkReservedSubunits: String(h.reserved_subunits),
        ...(h.captured_subunits !== null
          ? { sparkCapturedSubunits: String(h.captured_subunits) }
          : {}),
      }
    : {};
}

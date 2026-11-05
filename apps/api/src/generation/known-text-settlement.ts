import type { PoolClient, QueryResultRow } from 'pg';
import { providerMicrosToSparkSubunits } from '@dreamwalk/contracts';
import { digest } from '../ai/context';
import { SparksAccounting, DREAMS_FIRST_POLICY, sparkQuoteRateVersion } from './sparks-accounting';
import { fenceGenerationAdmission } from './scope-fence';
import { textUsageCostMicros } from './text-pricing';

type Funding = {
  hold: QueryResultRow;
  quote: QueryResultRow;
  dreams?: { hold: QueryResultRow; quote: QueryResultRow };
};
function financialProof(
  owner: string,
  source: string,
  operation: string,
  reserve: number,
  actual: number,
  f: Funding,
) {
  const { hold: h, quote: q, dreams } = f;
  if (
    !Number.isSafeInteger(actual) ||
    actual < 0 ||
    !Number.isSafeInteger(reserve) ||
    reserve < actual ||
    h.owner_id !== owner ||
    q.owner_id !== owner ||
    q.id !== h.id ||
    q.operation_id !== operation ||
    h.source_kind !== 'text' ||
    q.source_kind !== 'text' ||
    h.source_id !== source ||
    q.source_id !== source ||
    !['held', 'pending'].includes(h.status) ||
    (h.status === 'pending' && !['unknown', 'failure_policy_pending'].includes(h.reason)) ||
    h.captured_subunits !== null ||
    h.settlement_fingerprint !== null ||
    String(h.reserved_subunits) !== String(q.reserve_subunits) ||
    String(h.reserved_subunits) !==
      providerMicrosToSparkSubunits(String(reserve), sparkQuoteRateVersion(q.price_snapshot))
  )
    return false;
  const spark = BigInt(h.sparks_reserved_subunits ?? h.reserved_subunits),
    total = BigInt(h.reserved_subunits),
    dream = total - spark;
  if (spark < 0n || dream < 0n || !!h.dream_hold_id !== dream > 0n) return false;
  if (dream === 0n) return !dreams;
  const dh = dreams?.hold,
    dq = dreams?.quote;
  return (
    !!dh &&
    !!dq &&
    q.price_snapshot.fundingPolicy === DREAMS_FIRST_POLICY &&
    dh.id === h.dream_hold_id &&
    dq.id === dh.id &&
    dh.owner_id === owner &&
    dq.owner_id === owner &&
    dh.source_kind === 'text' &&
    dq.source_kind === 'text' &&
    dh.source_id === source &&
    dq.source_id === source &&
    dq.operation_id === h.id &&
    String(dh.reserved_subunits) === String(dream) &&
    String(dq.reserve_subunits) === String(dream) &&
    dq.price_snapshot?.currency === 'dreams' &&
    dq.price_snapshot?.policyVersion === DREAMS_FIRST_POLICY &&
    dq.price_snapshot?.providerQuote?.sparkQuoteId === h.id &&
    digest(dq.price_snapshot?.providerQuote?.priceSnapshot) === digest(q.price_snapshot) &&
    dh.status === h.status &&
    (h.status !== 'pending' || dh.reason === 'unknown') &&
    dh.captured_subunits === null &&
    dh.settlement_fingerprint === null
  );
}
function reservationProof(
  a: QueryResultRow,
  r: QueryResultRow,
  owner: string,
  id: string,
  key: string,
  quoteId: string,
  reserve: number,
  actual: number,
) {
  return (
    a.mode === 'release' &&
    a.owner_id === owner &&
    a.scope_id === `release:${owner}` &&
    r.id === id &&
    r.actor_id === owner &&
    r.scope_id === a.scope_id &&
    r.kind === 'text' &&
    r.operation_key === key &&
    r.spark_quote_id === quoteId &&
    r.status === 'settled' &&
    String(r.upper_micros) === String(reserve) &&
    String(r.actual_micros) === String(actual)
  );
}
/** PostgreSQL int8 is returned as a decimal string by node-pg. Decode only
 * canonical nonnegative integers that can be represented exactly in JavaScript. */
function countTokens(value: unknown): number | undefined {
  if (typeof value === 'number')
    return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0) ? value : undefined;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(value)) return undefined;
  if (BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return Number(value);
}
/** Fixed-price count receipt, including late/stale success. Never adopt its token count. */
export function knownCountSettlement(
  job: QueryResultRow,
  a: QueryResultRow,
  r: QueryResultRow,
  f: Funding,
) {
  try {
    const p = f.quote.price_snapshot?.providerQuote;
    const actual = Number(job.pricing_snapshot?.microsPerRequest);
    if (
      !['succeeded', 'over_context', 'stale', 'unknown'].includes(job.status) ||
      !job.completed_at ||
      countTokens(job.input_tokens) === undefined ||
      job.authorization_id !== a.id ||
      job.scope_id !== a.scope_id ||
      job.spark_quote_id !== f.hold.id ||
      String(job.actual_micros) !== String(actual) ||
      !job.request_hash ||
      !job.body_sha256 ||
      !job.source_hash ||
      !p ||
      p.automaticKnownCostPolicy !== 'known-cost-v1' ||
      digest(p.automaticKnownCostAcceptance ?? null) !==
        digest({ policy: 'known-cost-v1', requestHash: job.request_hash }) ||
      p.countId !== job.id ||
      p.model !== job.model ||
      p.providerVersion !== job.provider_version ||
      f.quote.price_snapshot.tariff?.provider !== 'openai' ||
      f.quote.price_snapshot.tariff?.providerRateVersion !== job.provider_version ||
      f.quote.price_snapshot.tariff?.model !== job.model ||
      p.requestHash !== job.request_hash ||
      digest(p.pricing) !== digest(job.pricing_snapshot) ||
      p.policy?.revision !== Number(job.policy_revision) ||
      p.policy?.hash !== job.policy_hash ||
      !reservationProof(
        a,
        r,
        job.actor_id,
        job.reservation_id,
        `text-count:${job.operation_id}`,
        job.spark_quote_id,
        actual,
        actual,
      ) ||
      !financialProof(job.actor_id, `count:${job.id}`, job.id, actual, actual, f)
    )
      return;
    return {
      outcome: 'success' as const,
      actualMicros: String(actual),
      evidence: 'configured_rates' as const,
      receiptId: `count:${job.id}`,
    };
  } catch {
    return;
  }
}
/** Permit admission is durable consent; final NPC usage must independently verify the bill. */
export function knownPermitSettlement(
  p: QueryResultRow,
  j: QueryResultRow,
  request: QueryResultRow,
  a: QueryResultRow,
  r: QueryResultRow,
  f: Funding,
  live = false,
) {
  try {
    const admitted = f.quote.price_snapshot?.providerQuote,
      snapshot = p.request_snapshot,
      usage = j.provider_usage;
    if (
      !snapshot ||
      !usage ||
      !admitted ||
      admitted.automaticKnownCostPolicy !== 'known-cost-v1' ||
      digest(admitted.automaticKnownCostAcceptance ?? null) !==
        digest({
          policy: 'known-cost-v1',
          operationId: p.operation_id,
          requestId: p.request_id,
          campaignId: p.campaign_id,
          authorizationId: p.session_id,
          contextHash: p.context_hash,
        }) ||
      !p.dispatched_at ||
      !p.completed_at ||
      p.state !== 'settled' ||
      !(live ? ['running', 'result_received', 'stale', 'failed'] : ['stale', 'failed']).includes(
        j.status,
      ) ||
      p.context_hash === 'erased' ||
      p.result_code === 'DATA_ERASED' ||
      p.session_id !== a.id ||
      p.spark_quote_id !== f.hold.id ||
      p.job_id !== j.id ||
      j.generation_authorization_id !== a.id ||
      j.spark_hold_id ||
      j.payer_user_id !== a.owner_id ||
      j.requester_user_id !== a.owner_id ||
      j.sponsor_id ||
      j.credits !== 0 ||
      j.provider_external !== true ||
      j.provider_budget_status !== 'spent' ||
      j.provider_cost_evidence !== 'configured_rates' ||
      usage.costEvidence !== 'configured_rates' ||
      usage.costVerifiedForSparks !== true ||
      j.request_meta?.runtimeRequestId !== p.request_id ||
      request.id !== p.request_id ||
      request.job_id !== j.id ||
      request.campaign_id !== p.campaign_id ||
      j.campaign_id !== p.campaign_id ||
      request.npc_id !== j.npc_id ||
      request.purpose !== j.purpose ||
      request.requester_user_id !== a.owner_id ||
      digest(request.context) !== p.context_hash ||
      digest(j.context) !== p.context_hash ||
      digest(j.request_snapshot) !== digest(snapshot) ||
      digest(admitted.estimateSnapshot) !== digest(snapshot) ||
      admitted.permitId !== p.id ||
      admitted.requestId !== p.request_id ||
      admitted.contextHash !== p.context_hash ||
      admitted.policy?.revision !== Number(p.generation_policy_revision) ||
      admitted.policy?.hash !== p.generation_policy_hash ||
      ['model', 'inputMicrosPerMillion', 'outputMicrosPerMillion', 'cachePricing'].some(
        (k) => digest(admitted.profile?.[k] ?? null) !== digest(snapshot[k] ?? null),
      ) ||
      !['inputTokens', 'outputTokens'].every((k) => Number.isSafeInteger(usage[k]) && usage[k] >= 0)
    )
      return;
    const tariff = f.quote.price_snapshot.tariff;
    if (
      !tariff ||
      tariff.provider !== 'openai' ||
      tariff.providerRateVersion !== p.generation_policy_hash ||
      tariff.model !== snapshot.model ||
      tariff.inputMicrosPerMillion !== String(snapshot.inputMicrosPerMillion) ||
      tariff.outputMicrosPerMillion !== String(snapshot.outputMicrosPerMillion) ||
      tariff.cachedInputMicrosPerMillion !==
        String(
          snapshot.cachePricing?.cachedInputMicrosPerMillion ?? snapshot.inputMicrosPerMillion,
        ) ||
      (snapshot.cachePricing &&
        tariff.cacheWriteMicrosPerMillion !==
          String(snapshot.cachePricing.cacheWrite30mMicrosPerMillion))
    )
      return;
    const cost = textUsageCostMicros(snapshot, usage);
    if (
      !cost.costVerifiedForSparks ||
      cost.costMicros !== usage.costMicros ||
      String(j.provider_actual_micros) !== String(cost.costMicros) ||
      String(j.input_tokens) !== String(usage.inputTokens) ||
      String(j.output_tokens) !== String(usage.outputTokens) ||
      String(j.cached_input_tokens ?? 0) !== String(usage.cachedInputTokens ?? 0) ||
      String(j.provider_upper_micros) !== String(snapshot.reserveMicros) ||
      !reservationProof(
        a,
        r,
        a.owner_id,
        p.reservation_id,
        `manual-text:${p.request_id}`,
        p.spark_quote_id,
        snapshot.reserveMicros,
        cost.costMicros,
      ) ||
      !financialProof(a.owner_id, p.request_id, p.id, snapshot.reserveMicros, cost.costMicros, f)
    )
      return;
    return {
      outcome: 'success' as const,
      actualMicros: String(cost.costMicros),
      evidence: 'configured_rates' as const,
      receiptId: `permit:${p.id}`,
    };
  } catch {
    return;
  }
}
async function funding(c: PoolClient, owner: string, id: string): Promise<Funding | undefined> {
  await fenceGenerationAdmission(c);
  await c.query('SELECT owner_id FROM spark_wallets WHERE owner_id=$1 FOR UPDATE', [owner]);
  const hold = (
    await c.query('SELECT * FROM spark_holds WHERE id=$1 AND owner_id=$2 FOR UPDATE', [id, owner])
  ).rows[0];
  if (!hold || ['settled', 'released'].includes(hold.status)) return;
  const quote = (
    await c.query('SELECT * FROM spark_quotes WHERE id=$1 AND owner_id=$2', [id, owner])
  ).rows[0];
  if (!quote) return;
  let dreams;
  if (hold.dream_hold_id) {
    await c.query('SELECT owner_id FROM dream_wallets WHERE owner_id=$1 FOR UPDATE', [owner]);
    const dh = (
      await c.query('SELECT * FROM dream_holds WHERE id=$1 AND owner_id=$2 FOR UPDATE', [
        hold.dream_hold_id,
        owner,
      ])
    ).rows[0];
    const dq = (
      await c.query('SELECT * FROM dream_quotes WHERE id=$1 AND owner_id=$2', [
        hold.dream_hold_id,
        owner,
      ])
    ).rows[0];
    if (!dh || !dq) return;
    dreams = { hold: dh, quote: dq };
  }
  return { hold, quote, dreams };
}
/** Caller owns authorization/scope and the source row, in its normal lock order. */
export async function settleKnownCount(
  c: PoolClient,
  job: QueryResultRow,
  authorization: QueryResultRow,
) {
  if (!job.spark_quote_id) return;
  const reservation = (
    await c.query('SELECT * FROM generation_budget_reservations WHERE id=$1', [job.reservation_id])
  ).rows[0];
  if (!reservation) return;
  const f = await funding(c, job.actor_id, job.spark_quote_id);
  if (!f) return;
  const receipt = knownCountSettlement(job, authorization, reservation, f);
  if (!receipt) return;
  await new SparksAccounting().settle(c, job.actor_id, job.spark_quote_id, receipt, true);
  // Accounting only. No stale count is installed into a runtime request.
  if (job.status === 'unknown')
    await c.query(
      "UPDATE generation_text_counts SET status='stale',result_code='TEXT_COUNT_LATE_COST_SETTLED' WHERE id=$1",
      [job.id],
    );
  return true;
}
export async function settleKnownPermit(
  c: PoolClient,
  p: QueryResultRow,
  authorization: QueryResultRow,
  live = false,
) {
  if (!p.spark_quote_id || !p.job_id) return;
  const job = (await c.query('SELECT * FROM npc_ai_jobs WHERE id=$1', [p.job_id])).rows[0];
  const request = (
    await c.query('SELECT * FROM game_npc_decision_requests WHERE id=$1', [p.request_id])
  ).rows[0];
  const reservation = (
    await c.query('SELECT * FROM generation_budget_reservations WHERE id=$1', [p.reservation_id])
  ).rows[0];
  if (!job || !request || !reservation) return;
  const f = await funding(c, authorization.owner_id, p.spark_quote_id);
  if (!f) return;
  const receipt = knownPermitSettlement(p, job, request, authorization, reservation, f, live);
  if (!receipt) return;
  await new SparksAccounting().settle(c, authorization.owner_id, p.spark_quote_id, receipt, true);
  return true;
}

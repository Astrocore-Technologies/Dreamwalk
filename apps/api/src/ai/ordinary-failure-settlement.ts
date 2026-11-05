import type { QueryResultRow } from 'pg';
import { digest } from './context';
import { knownNpcSettlementQuote } from '../game/known-npc-settlement';
import type { SparkSettlement } from '../generation/sparks-accounting';

/** The End turn allowance is finite, persisted by the server and never retroactive.
 * A semantic failure is not an unknown provider bill. It may settle the original
 * held reservation once, but can never authorize another generation or a retry. */
export function ordinaryFailureSettlement(
  job: QueryResultRow,
  batch: QueryResultRow | undefined,
  request: QueryResultRow | undefined,
  hold: QueryResultRow | undefined,
  quote: QueryResultRow | undefined,
): SparkSettlement | undefined {
  if (!batch || !request || !hold || !quote) return;
  const acceptedAt = batch.accepted_at ? new Date(batch.accepted_at).getTime() : NaN;
  const entries = Array.isArray(batch.entries) ? batch.entries : [];
  const matches = entries.filter(
    (entry: { requestId?: string; quote?: { id?: string } }) =>
      entry.requestId === request.id && entry.quote?.id === job.quote_id,
  );
  if (
    batch.quote?.ordinaryTurnConsentVersion !== 'end-turn-v1' ||
    (batch.quote?.generatedLocationImages ?? 0) !== 0 ||
    batch.quote?.estimateRiskConsentRequired === true ||
    (batch.media_entries != null &&
      (!Array.isArray(batch.media_entries) || batch.media_entries.length !== 0)) ||
    !['accepted', 'stale'].includes(batch.state) ||
    !Number.isFinite(acceptedAt) ||
    !(acceptedAt < new Date(batch.expires_at).getTime()) ||
    batch.id !== job.request_meta?.acceptedWorldBatchId ||
    batch.owner_id !== job.payer_user_id ||
    batch.campaign_id !== job.campaign_id ||
    request.id !== job.request_meta?.runtimeRequestId ||
    request.job_id !== job.id ||
    request.requester_user_id !== job.payer_user_id ||
    request.campaign_id !== job.campaign_id ||
    request.npc_id !== job.npc_id ||
    request.purpose !== job.purpose ||
    matches.length !== 1 ||
    matches[0].npcId !== job.npc_id ||
    matches[0].purpose !== job.purpose ||
    matches[0].contextDigest !== digest(job.context) ||
    matches[0].contextDigest !== digest(request.context) ||
    quote.price_snapshot?.providerQuote?.policyVersion !== job.policy_version ||
    quote.price_snapshot?.providerQuote?.contextHash !== job.context_hash ||
    BigInt(job.provider_actual_micros ?? -1) < 0n ||
    BigInt(job.provider_actual_micros ?? -1) > BigInt(job.provider_upper_micros)
  )
    return;
  try {
    const bill = knownNpcSettlementQuote(job, hold, quote, 'ordinary-failure');
    return {
      outcome: 'success',
      actualMicros: bill.actualMicros,
      evidence: 'configured_rates',
      receiptId: `ordinary-failure:${job.id}`,
    };
  } catch {
    // Unpriced usage, an old pending hold or any mismatched provenance stays closed.
    return;
  }
}

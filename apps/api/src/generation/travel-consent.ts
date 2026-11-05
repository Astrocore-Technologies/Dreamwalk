import type { PoolClient } from 'pg';
import { matchesTurnFence } from '@dreamwalk/game-core';
import { digest } from '../ai/context';
import { imageKnownCostPolicy } from '../image-generation/settlement-policy';
import { acceptedWorldKnownCostPolicyMatches } from './known-cost-policy';

/** Read-only immutable evidence: callers retain native source/admission locks; never acquire game locks after budget locks. Identifiers only. Every caller independently verifies the finite original consent. */
export type AcceptedTravelBatchProof = {
  batchId: string;
  preparationId: string;
  nativeQuoteId: string;
};
export async function verifyAcceptedTravelBatch(
  c: PoolClient,
  ownerId: string,
  proof: AcceptedTravelBatchProof,
  sparkQuoteId?: string,
  existingJobId?: string,
) {
  const prep = (
    await c.query('SELECT * FROM game_location_travel_preparations WHERE id=$1', [
      proof.preparationId,
    ])
  ).rows[0];
  const batch = (
    await c.query('SELECT * FROM game_world_generation_batches WHERE id=$1', [proof.batchId])
  ).rows[0];
  const native = (
    await c.query('SELECT * FROM image_generation_quotes WHERE id=$1', [proof.nativeQuoteId])
  ).rows[0];
  const request = (
    await c.query('SELECT * FROM game_npc_decision_requests WHERE id=$1', [proof.preparationId])
  ).rows[0];
  const campaign =
    prep &&
    (
      await c.query('SELECT state,status,owner_id FROM game_campaigns WHERE id=$1', [
        prep.campaign_id,
      ])
    ).rows[0];
  const entries = Array.isArray(batch?.media_entries) ? batch.media_entries : [];
  const matches = entries.filter(
    (entry: { preparationId: string; imageQuoteId: string }) =>
      entry.preparationId === proof.preparationId && entry.imageQuoteId === proof.nativeQuoteId,
  );
  const textEntries = Array.isArray(batch?.entries)
    ? batch.entries.filter(
        (entry: { requestId: string; contextDigest: string }) =>
          entry.requestId === proof.preparationId,
      )
    : [];
  const acceptedAt = batch?.accepted_at ? new Date(batch.accepted_at).getTime() : NaN;
  const comparable = { ...native?.input };
  delete comparable.generationAuthorizationId;
  const inputHash = digest(comparable);
  if (
    !prep ||
    prep.state !== 'accepted' ||
    prep.owner_id !== ownerId ||
    prep.batch_id !== proof.batchId ||
    prep.image_quote?.id !== proof.nativeQuoteId ||
    prep.image_job_id !== (existingJobId ?? null) ||
    !batch ||
    batch.state !== 'accepted' ||
    batch.owner_id !== ownerId ||
    batch.campaign_id !== prep.campaign_id ||
    !Number.isFinite(acceptedAt) ||
    !(acceptedAt < new Date(batch.expires_at).getTime()) ||
    matches.length !== 1 ||
    textEntries.length !== 1 ||
    textEntries[0].contextDigest !== digest(request?.context ?? null) ||
    !native ||
    native.actor_id !== ownerId ||
    Number(native.upper_micros) !== Number(matches[0]?.quote?.providerReserveMicros) ||
    Number(native.upper_micros) !== Number(prep.image_quote?.reserveMicros) ||
    native.input?.travelContext?.preparationId !== prep.id ||
    inputHash !== prep.input_hash ||
    !(acceptedAt < new Date(native.expires_at).getTime()) ||
    !request ||
    request.campaign_id !== prep.campaign_id ||
    request.status !== 'queued' ||
    request.job_id ||
    request.requester_user_id !== ownerId ||
    !campaign ||
    campaign.status !== 'active' ||
    campaign.owner_id !== ownerId ||
    campaign.state?.turnController?.phase !== 'world' ||
    !matchesTurnFence(campaign.state, batch.turn_fence)
  )
    throw new Error('TRAVEL_BATCH_CONSENT_STALE');
  const automaticPolicy =
    native.input?.automaticKnownCostPolicy === 'known-cost-v1'
      ? imageKnownCostPolicy({
          quoteId: native.id,
          requestHash: native.request_hash,
          reserveMicros: String(native.upper_micros),
          costBasis: native.cost_basis,
        })
      : undefined;
  if (
    automaticPolicy &&
    (!acceptedWorldKnownCostPolicyMatches(batch) ||
      matches[0].automaticKnownCostPolicyHash !== automaticPolicy.fingerprint ||
      matches[0].quote.automaticKnownCostPolicyHash !== automaticPolicy.fingerprint ||
      prep.image_quote.automaticKnownCostSettlement?.fingerprint !== automaticPolicy.fingerprint ||
      !sparkQuoteId)
  )
    throw new Error('TRAVEL_BATCH_CONSENT_STALE');
  if (
    !automaticPolicy &&
    (matches[0].automaticKnownCostPolicyHash || prep.image_quote.automaticKnownCostSettlement)
  )
    throw new Error('TRAVEL_BATCH_CONSENT_STALE');
  const jobs = await c.query('SELECT id FROM image_generation_jobs WHERE quote_id=$1', [native.id]);
  if (jobs.rows.some((job) => job.id !== existingJobId) || (existingJobId && !jobs.rowCount))
    throw new Error('QUOTE_CONSUMED');
  if (
    (
      await c.query(
        `SELECT 1 FROM npc_ai_jobs j LEFT JOIN spark_holds h ON h.id=j.spark_hold_id
    WHERE j.campaign_id=$1 AND (j.status='reconciling' OR h.status='pending')
    UNION ALL SELECT 1 FROM live_test_text_permits WHERE campaign_id=$1 AND state='unknown'
    UNION ALL SELECT 1 FROM game_location_travel_preparations p JOIN image_generation_jobs j ON j.id=p.image_job_id
      LEFT JOIN spark_holds h ON h.id=j.spark_quote_id
      WHERE p.campaign_id=$1 AND (j.status='unknown' OR h.status='pending') AND j.id IS DISTINCT FROM $2::uuid LIMIT 1`,
        [prep.campaign_id, existingJobId ?? null],
      )
    ).rowCount
  )
    throw new Error('LIVE_OUTCOME_UNRESOLVED');
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
      spark.source_kind !== 'image' ||
      String(spark.reserve_subunits) !== matches[0].quote.sparkReservedSubunits ||
      String(spark.reserve_subunits) !== prep.image_quote.sparks?.reserveSubunits ||
      spark.price_snapshot?.tariff?.sparkRateVersion !== matches[0].quote.sparkRateVersion ||
      spark.price_snapshot?.tariff?.sparkRateVersion !== prep.image_quote.sparks?.rateVersion ||
      spark.source_id !== native.id ||
      spark.operation_id !== native.id ||
      !(acceptedAt < new Date(spark.expires_at).getTime()) ||
      digest(spark.price_snapshot?.providerQuote) !==
        digest({
          quoteId: native.id,
          requestHash: native.request_hash,
          pricingProfile: native.pricing_profile_snapshot,
          estimate: native.estimate_snapshot,
          ...(automaticPolicy
            ? {
                automaticKnownCostPolicy: 'known-cost-v1',
                automaticKnownCostPolicyHash: automaticPolicy.fingerprint,
              }
            : {}),
          settlement: 'actual-image-micros',
          cachePricing: 'not-quoted',
        })
    )
      throw new Error('TRAVEL_BATCH_CONSENT_STALE');
  }
  return { automaticKnownCostPolicyHash: automaticPolicy?.fingerprint };
}

import {
  acceptedWorldKnownCostPolicyMatches,
  worldKnownCostPolicyRequired,
} from './known-cost-policy';
import type { PoolClient } from 'pg';
import { matchesTurnFence } from '@dreamwalk/game-core';
import { digest } from '../ai/context';
import {
  travelGroundingConsentHash,
  assertTravelGroundingSnapshot,
} from './travel-grounding-envelope';
import type { AuthoringTextProfile } from '../live-test/authoring-provider';
export type AcceptedTravelGroundingProof = {
  preparationId: string;
  batchId: string;
  nativeQuoteId: string;
};
/** Verify the actual child against the original bounded tranche, not an invented exact quote.
 * Read-only: caller already owns source and native admission locks. */
export async function verifyAcceptedTravelGrounding(
  c: PoolClient,
  ownerId: string,
  proof: AcceptedTravelGroundingProof,
  profile: AuthoringTextProfile,
  providerVersion: string,
) {
  const prep = (
    await c.query('SELECT * FROM game_location_travel_preparations WHERE id=$1', [
      proof.preparationId,
    ])
  ).rows[0];
  const g = (
    await c.query('SELECT * FROM game_travel_map_groundings WHERE preparation_id=$1', [
      proof.preparationId,
    ])
  ).rows[0];
  const batch = (
    await c.query('SELECT * FROM game_world_generation_batches WHERE id=$1', [proof.batchId])
  ).rows[0];
  const native = (
    await c.query('SELECT * FROM live_authoring_text_quotes WHERE id=$1', [proof.nativeQuoteId])
  ).rows[0];
  const campaign =
    prep &&
    (
      await c.query('SELECT state,status,owner_id FROM game_campaigns WHERE id=$1', [
        prep.campaign_id,
      ])
    ).rows[0];
  const entries = (batch?.media_entries ?? []).filter(
    (e: { preparationId: string }) => e.preparationId === proof.preparationId,
  );
  const request = (
    await c.query('SELECT * FROM game_npc_decision_requests WHERE id=$1', [proof.preparationId])
  ).rows[0];
  const textEntries = (batch?.entries ?? []).filter(
    (e: { requestId: string }) => e.requestId === proof.preparationId,
  );
  const accepted = Date.parse(batch?.accepted_at);
  if (
    !request ||
    request.status !== 'queued' ||
    request.job_id ||
    request.requester_user_id !== ownerId ||
    request.campaign_id !== prep?.campaign_id ||
    textEntries.length !== 1 ||
    textEntries[0].contextDigest !== digest(request.context) ||
    !prep ||
    prep.state !== 'accepted' ||
    prep.owner_id !== ownerId ||
    prep.batch_id !== proof.batchId ||
    !g ||
    !['bound', 'queued'].includes(g.status) ||
    !batch ||
    batch.state !== 'accepted' ||
    (worldKnownCostPolicyRequired(batch) && !acceptedWorldKnownCostPolicyMatches(batch)) ||
    batch.quote?.travelGroundingPolicyHash !==
      travelGroundingConsentHash(batch.entries, batch.media_entries) ||
    batch.owner_id !== ownerId ||
    batch.campaign_id !== prep.campaign_id ||
    !Number.isFinite(accepted) ||
    accepted >= Date.parse(batch.expires_at) ||
    entries.length !== 1 ||
    digest(entries[0].grounding) !== digest({ envelope: g.envelope, quote: g.quote }) ||
    accepted >= Date.parse(g.quote.expiresAt) ||
    !native ||
    native.id !== g.native_quote_id ||
    native.actor_id !== ownerId ||
    native.session_id !== g.envelope.authorizationId ||
    native.generation_policy_revision !== g.envelope.policyRevision ||
    native.generation_policy_hash !== g.envelope.policyHash ||
    native.project_id !== g.project_id ||
    native.context_hash !== g.context_hash ||
    native.context_hash !== digest(native.context) ||
    native.source_hash !== prep.source_checksum ||
    native.readset_hash !== g.context_hash ||
    g.context_hash !== digest(g.context) ||
    g.envelope.sourceChecksum !== prep.source_checksum ||
    g.envelope.imageRequestHash !== prep.input_hash ||
    native.provider_version !== providerVersion ||
    !campaign ||
    campaign.status !== 'active' ||
    campaign.owner_id !== ownerId ||
    !matchesTurnFence(campaign.state, batch.turn_fence)
  )
    throw Error('TRAVEL_GROUNDING_CONSENT_STALE');
  const image = (
    await c.query('SELECT status,admitted_revision_id FROM image_generation_jobs WHERE id=$1', [
      prep.image_job_id,
    ])
  ).rows[0];
  if (
    image?.status !== 'admitted' ||
    image.admitted_revision_id !== g.image_revision_id ||
    g.context.mapImages?.length !== 1 ||
    g.context.mapImages[0].revisionId !== g.image_revision_id ||
    g.context.mapImages[0].sha256 !== g.image_sha256
  )
    throw Error('MAP_IMAGE_SOURCE_MISMATCH');
  assertTravelGroundingSnapshot(g.envelope, native.request_snapshot, profile, providerVersion);
  if (Number(native.upper_micros) !== native.request_snapshot.reserveMicros)
    throw Error('TRAVEL_GROUNDING_CONSENT_STALE');
  const spark = (
    await c.query('SELECT reserve_subunits,price_snapshot FROM spark_quotes WHERE id=$1', [
      native.spark_quote_id,
    ])
  ).rows[0];
  if (!spark || BigInt(spark.reserve_subunits) > BigInt(g.quote.sparkReservedSubunits))
    throw Error('LOCATION_GROUNDING_ALLOWANCE_EXCEEDED');
}

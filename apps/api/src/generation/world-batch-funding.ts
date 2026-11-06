import type { PoolClient } from 'pg';
import { parseSparkInteger, type StoryQuote } from '@dreamwalk/contracts';
import { CURRENCY_FUNDING_POLICY } from './currency-funding';

type Funding = { total: bigint; sparksOnly: bigint };
type PricedEntry = { quote: StoryQuote };

/** Original mandatory prices only. Future optional speech is permission, not a wallet hold. */
export function mandatoryWorldBatchFunding(batch: {
  entries: PricedEntry[];
  media_entries?: (PricedEntry & { grounding?: PricedEntry })[];
}): Funding {
  const media = batch.media_entries ?? [];
  const entries = [
    ...batch.entries,
    ...media,
    ...media.flatMap((e) => (e.grounding ? [e.grounding] : [])),
  ];
  return entries.reduce(
    (sum, { quote }) => {
      const amount = parseSparkInteger(quote.sparkReservedSubunits ?? 'invalid');
      return {
        total: sum.total + amount,
        sparksOnly:
          sum.sparksOnly + (quote.funding?.policyVersion === CURRENCY_FUNDING_POLICY ? 0n : amount),
      };
    },
    { total: 0n, sparksOnly: 0n },
  );
}

/** Caller retains the payer's Spark wallet lock through acceptance/reservation.
 * Read, never lock other campaigns here: all batch acceptances and native holds
 * serialize on that wallet. Committed holds are already removed from availability;
 * terminal requests cannot restart and no longer need an unpaid allocation.
 * Media tranches keep their original ceiling until their exact native hold exists.
 */
export async function pendingWorldBatchFunding(c: PoolClient, ownerId: string): Promise<Funding> {
  const rows = (
    await c.query(
      `WITH accepted AS (
        SELECT b.* FROM game_world_generation_batches b
        JOIN game_campaigns campaign ON campaign.id=b.campaign_id
        WHERE b.owner_id=$1 AND b.state='accepted' AND b.accepted_at IS NOT NULL
          AND campaign.status='active'
          AND campaign.state->'turnController'->>'phase'='world'
          AND b.turn_fence=jsonb_build_object(
            'roundId',campaign.state->'turnController'->'roundId',
            'phaseEpoch',campaign.state->'turnController'->'phaseEpoch',
            'rulesetVersion',campaign.state->'turnController'->'ruleset'->'version')
      ), unpaid AS (
        SELECT e->'quote'->>'sparkReservedSubunits' AS amount,q.price_snapshot->>'fundingPolicy' AS funding_policy
        FROM accepted b CROSS JOIN LATERAL jsonb_array_elements(b.entries) e
        JOIN game_npc_decision_requests r ON r.id=(e->>'requestId')::uuid AND r.campaign_id=b.campaign_id
        JOIN npc_ai_quotes native ON native.id=(e->'quote'->>'id')::uuid
        JOIN spark_quotes q ON q.id=native.spark_quote_id AND q.owner_id=b.owner_id
        WHERE r.status='queued' AND r.job_id IS NULL
          AND NOT EXISTS(SELECT 1 FROM spark_holds h WHERE h.id=q.id)
          AND NOT EXISTS(SELECT 1 FROM npc_ai_jobs j WHERE j.quote_id=native.id)
        UNION ALL
        SELECT e->'quote'->>'sparkReservedSubunits',q.price_snapshot->>'fundingPolicy'
        FROM accepted b CROSS JOIN LATERAL jsonb_array_elements(b.media_entries) e
        JOIN game_location_travel_preparations p ON p.id=(e->>'preparationId')::uuid AND p.batch_id=b.id
        JOIN image_generation_quotes native ON native.id=(e->>'imageQuoteId')::uuid
        JOIN spark_quotes q ON q.id=native.spark_quote_id AND q.owner_id=b.owner_id
        WHERE p.state='accepted' AND p.image_job_id IS NULL
          AND NOT EXISTS(SELECT 1 FROM spark_holds h WHERE h.id=q.id)
          AND NOT EXISTS(SELECT 1 FROM image_generation_jobs j WHERE j.quote_id=native.id)
        UNION ALL
        SELECT e->'grounding'->'quote'->>'sparkReservedSubunits',q.price_snapshot->>'fundingPolicy'
        FROM accepted b CROSS JOIN LATERAL jsonb_array_elements(b.media_entries) e
        JOIN game_location_travel_preparations p ON p.id=(e->>'preparationId')::uuid AND p.batch_id=b.id
        JOIN game_travel_map_groundings g ON g.preparation_id=p.id
        JOIN spark_quotes q ON q.id=g.spark_quote_id AND q.owner_id=b.owner_id
        LEFT JOIN live_authoring_text_quotes native ON native.id=g.native_quote_id
        WHERE p.state='accepted' AND g.status IN ('prepared','bound','unknown') AND g.job_id IS NULL
          AND NOT EXISTS(SELECT 1 FROM spark_holds h WHERE h.id=native.spark_quote_id)
          AND NOT EXISTS(SELECT 1 FROM live_authoring_text_jobs j WHERE j.quote_id=native.id)
      ) SELECT amount,funding_policy FROM unpaid`,
      [ownerId],
    )
  ).rows;
  return rows.reduce(
    (sum, row) => {
      const amount = parseSparkInteger(row.amount);
      return {
        total: sum.total + amount,
        sparksOnly: sum.sparksOnly + (row.funding_policy === CURRENCY_FUNDING_POLICY ? 0n : amount),
      };
    },
    { total: 0n, sparksOnly: 0n },
  );
}

import type { PoolClient } from 'pg';

/** Exact frozen child, terminal result and both settled liabilities. Never late geometry. */
const terminalSources = `game_location_travel_preparations p, live_authoring_text_jobs j,
  live_authoring_text_quotes q, generation_budget_reservations r, spark_holds h`;
const resolvedTerminalChild = `WHERE p.id=g.preparation_id AND p.campaign_id=$1
       AND g.status='unknown' AND g.result IS NULL
       AND j.id=g.job_id AND j.operation_id=g.job_operation_id
       AND j.quote_id=g.native_quote_id AND q.id=g.native_quote_id
       AND j.project_id=g.project_id AND q.project_id=g.project_id
       AND j.actor_id=p.owner_id AND q.actor_id=p.owner_id
       AND j.context_hash=g.context_hash AND q.context_hash=g.context_hash
       AND j.source_hash=p.source_checksum AND q.source_hash=p.source_checksum
       AND j.readset_hash=g.context_hash AND q.readset_hash=g.context_hash
       AND j.provider_version=q.provider_version
       AND j.status IN ('stale','failed','cancelled') AND j.completed_at IS NOT NULL
       AND j.actual_micros IS NOT NULL
       AND r.id=j.reservation_id AND r.actor_id=j.actor_id
       AND r.status='settled' AND r.actual_micros=j.actual_micros
       AND h.id=j.spark_quote_id AND q.spark_quote_id=h.id AND r.spark_quote_id=h.id
       AND h.owner_id=j.actor_id AND h.status IN ('settled','released')
       AND h.captured_subunits IS NOT NULL AND h.settled_at IS NOT NULL`;

/** Read-only status projection: legacy recovery and GET routes must not mutate state. */
export async function resolvedTerminalTravelGroundings(
  c: Pick<PoolClient, 'query'>,
  campaignId: string,
) {
  const result = await c.query(
    `SELECT g.preparation_id FROM game_travel_map_groundings g  , ${terminalSources} ${resolvedTerminalChild}`,
    [campaignId],
  );
  return new Set<string>(result.rows.map((row) => row.preparation_id));
}

/** Dispatcher-only repair. No dispatch, retry, settlement or geometry application. */
export async function reconcileTerminalTravelGrounding(
  c: Pick<PoolClient, 'query'>,
  campaignId: string,
) {
  await c.query(
    `UPDATE game_travel_map_groundings g SET status='failed',error_code=COALESCE(j.error_code,'LOCATION_GROUNDING_FAILED'),updated_at=now() FROM ${terminalSources} ${resolvedTerminalChild}`,
    [campaignId],
  );
}

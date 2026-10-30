import type { PoolClient } from 'pg';
import type { GameState } from '@dreamwalk/contracts';
import { recordNpcMetric } from './npc-telemetry';

export interface NpcRetentionPolicy {
  unreferencedEpisodesPerNpc: number;
  privateHistoryEvents: number;
  batchLimit: number;
}
export const npcRetentionDefaults: NpcRetentionPolicy = {
  unreferencedEpisodesPerNpc: 4096,
  privateHistoryEvents: 1000,
  batchLimit: 1000,
};

/** IDs are collected from explicit evidence fields, never arbitrary text matching. */
export function protectedNpcEvidence(value: unknown, result = new Set<string>()): Set<string> {
  if (!value || typeof value !== 'object') return result;
  if (Array.isArray(value)) {
    for (const child of value) protectedNpcEvidence(child, result);
    return result;
  }
  const object = value as Record<string, unknown>;
  if (
    typeof object.id === 'string' &&
    typeof object.rootId === 'string' &&
    typeof object.eventId === 'string'
  )
    result.add(object.id);
  for (const [key, child] of Object.entries(object)) {
    if (
      ['evidenceIds', 'observationIds', 'sourceObservationIds'].includes(key) &&
      Array.isArray(child)
    )
      for (const id of child) if (typeof id === 'string') result.add(id);
    if (key === 'observationId' && typeof child === 'string') result.add(child);
    protectedNpcEvidence(child, result);
  }
  return result;
}

/** Called by the active campaign writer inside its checkpoint transaction, never an offline timer.
 * Keep all live dependencies plus a bounded unreferenced cold window. History compaction
 * removes private cognition only; game outcomes, sequence and idempotency receipts remain.
 */
export async function pruneNpcMemory(
  client: PoolClient,
  campaignId: string,
  state: GameState,
  sequence: number,
  policy: NpcRetentionPolicy = npcRetentionDefaults,
) {
  for (const value of Object.values(policy))
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('INVALID_NPC_RETENTION_POLICY');
  if (
    policy.unreferencedEpisodesPerNpc > 100000 ||
    policy.privateHistoryEvents > 100000 ||
    policy.batchLimit > 5000
  )
    throw new Error('INVALID_NPC_RETENTION_POLICY');
  const protectedIds = protectedNpcEvidence(state.npcBrains ?? {});
  protectedNpcEvidence(state.npcUtterances ?? [], protectedIds);
  const pending = await client.query(
    `SELECT context FROM npc_ai_jobs WHERE campaign_id=$1 AND status IN ('queued','reserved','running','result_received','validated')
     UNION ALL SELECT r.context FROM game_npc_decision_requests r LEFT JOIN npc_ai_jobs j ON j.id=r.job_id WHERE r.campaign_id=$1 AND (r.status='queued' OR (r.status='scheduled' AND j.status IN ('queued','reserved','running','result_received','validated')))`,
    [campaignId],
  );
  for (const row of pending.rows) protectedNpcEvidence(row.context, protectedIds);
  const removed = await client.query(
    `WITH ranked AS (
      SELECT npc_id,observation_id,row_number() OVER(PARTITION BY npc_id ORDER BY observed_tick DESC,observation_id) AS rank
      FROM game_npc_episodes WHERE campaign_id=$1 AND NOT(observation_id=ANY($2::text[]))
    ), expired AS (SELECT npc_id,observation_id FROM ranked WHERE rank>$3 LIMIT $4)
    DELETE FROM game_npc_episodes e USING expired x
    WHERE e.campaign_id=$1 AND e.npc_id=x.npc_id AND e.observation_id=x.observation_id`,
    [campaignId, [...protectedIds], policy.unreferencedEpisodesPerNpc, policy.batchLimit],
  );
  const cutoff = Math.max(0, sequence - policy.privateHistoryEvents);
  // Redact every cached occurrence of speech whose provenance is being removed,
  // including anonymous heard speech. Both updates share one MVCC statement/transaction.
  const history = await client.query(
    `WITH expired AS MATERIALIZED (
      SELECT sequence,payload FROM game_events WHERE campaign_id=$1 AND sequence<$2
      AND (payload#>'{state,npcBrains}' IS NOT NULL OR payload#>'{state,npcUtterances}' IS NOT NULL)
      ORDER BY sequence LIMIT $3
    ), expired_speech AS MATERIALIZED (
      SELECT DISTINCT utterance->>'id' AS id FROM expired e,
      LATERAL jsonb_array_elements(COALESCE(e.payload#>'{state,npcUtterances}','[]'::jsonb)) utterance
    ), redacted AS (
      UPDATE game_operations o SET result=jsonb_set(o.result,'{projection,npcUtterances}',
        COALESCE((SELECT jsonb_agg(u) FROM jsonb_array_elements(o.result#>'{projection,npcUtterances}') u
          WHERE NOT EXISTS(SELECT 1 FROM expired_speech x WHERE x.id=u->>'id')),'[]'::jsonb))
      WHERE o.campaign_id=$1 AND o.result#>'{projection,npcUtterances}' IS NOT NULL
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(o.result#>'{projection,npcUtterances}') u
          JOIN expired_speech x ON x.id=u->>'id') RETURNING 1
    ), compacted AS (
      UPDATE game_events e SET payload=jsonb_set((e.payload #- '{state,npcBrains}' #- '{state,npcUtterances}'),
        '{state,npcProvenance}',jsonb_build_object(
          'observations',COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
            'id',ob->'id','rootId',ob->'rootId','eventId',ob->'eventId','actorId',ob->'actorId',
            'targetId',ob->'targetId','sourceNpcId',ob->'sourceNpcId','addressedNpcId',ob->'addressedNpcId')))
            FROM jsonb_each(COALESCE(e.payload#>'{state,npcBrains}','{}'::jsonb)) b,
            LATERAL jsonb_array_elements(COALESCE(b.value#>'{living,observations}','[]'::jsonb)) ob),'[]'::jsonb),
          'utterances',COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
            'id',u->'id','speakerId',u->'speakerId','sourceObservationIds',u->'sourceObservationIds')))
            FROM jsonb_array_elements(COALESCE(e.payload#>'{state,npcUtterances}','[]'::jsonb)) u),'[]'::jsonb))) || '{"npcMemoryCompacted":true}'::jsonb
      FROM expired x WHERE e.campaign_id=$1 AND e.sequence=x.sequence RETURNING 1
    ) SELECT (SELECT count(*) FROM redacted)::int AS replays,
      (SELECT count(*) FROM compacted)::int AS states`,
    [campaignId, cutoff, policy.batchLimit],
  );
  const result = {
    episodes: removed.rowCount ?? 0,
    historicalStates: Number(history.rows[0]?.states ?? 0),
    replayConversations: Number(history.rows[0]?.replays ?? 0),
    protectedEvidence: protectedIds.size,
  };
  recordNpcMetric('retentionRuns');
  recordNpcMetric('retentionRemovedEpisodes', result.episodes);
  recordNpcMetric('retentionCompactedStates', result.historicalStates);
  recordNpcMetric('retentionRedactedReplays', result.replayConversations);
  return result;
}

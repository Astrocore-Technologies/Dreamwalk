import type { PoolClient } from 'pg';
import type { GameState, NpcObservation } from '@dreamwalk/contracts';
import type { Db } from '../db';
/** Same transaction as the authoritative checkpoint. No global event reconstruction. */
export async function archiveNpcEpisodes(c: PoolClient, campaignId: string, state: GameState) {
  const rows = Object.entries(state.npcBrains ?? {}).flatMap(([npcId, b]) =>
    (b.living?.observations ?? []).map((o) => ({ npcId, ...o })),
  );
  if (!rows.length) return;
  await c.query(
    `INSERT INTO game_npc_episodes(campaign_id,npc_id,observation_id,root_id,event_id,actor_id,target_id,source_npc_id,observed_tick,payload)
    SELECT $1,x->>'npcId',x->>'id',x->>'rootId',x->>'eventId',x->>'actorId',x->>'targetId',x->>'sourceNpcId',(x->>'tick')::bigint,x-'npcId'
    FROM jsonb_array_elements($2::jsonb) x ON CONFLICT(campaign_id,npc_id,observation_id) DO NOTHING`,
    [campaignId, JSON.stringify(rows)],
  );
}
/** Retrieval is private, per NPC, bounded, and relevance uses only that NPC's current knowledge. */
export async function recallNpcEpisodes(
  db: Db,
  campaignId: string,
  state: GameState,
  npcId: string,
): Promise<NpcObservation[]> {
  const m = state.npcBrains?.[npcId]?.living;
  if (!m) return [];
  const subjects = [
    m.goal.targetId,
    ...m.obligations.filter((o) => o.status === 'accepted').flatMap((o) => [o.toActorId, o.itemId]),
    ...m.observations.slice(-8).flatMap((o) => [o.actorId, o.targetId]),
  ].filter((x): x is string => Boolean(x));
  // First restrict a bounded indexed candidate window. No unbounded history sort per model call.
  const rows = await db.query(
    `WITH recent AS (
    SELECT observation_id,observed_tick,actor_id,target_id,payload FROM game_npc_episodes
    WHERE campaign_id=$1 AND npc_id=$2 AND NOT(observation_id=ANY($3::text[]))
    ORDER BY observed_tick DESC,observation_id LIMIT 128),
    relevant AS (SELECT observation_id,observed_tick,actor_id,target_id,payload FROM game_npc_episodes
    WHERE campaign_id=$1 AND npc_id=$2 AND NOT(observation_id=ANY($3::text[]))
    AND (actor_id=ANY($4::text[]) OR target_id=ANY($4::text[])) ORDER BY observed_tick DESC,observation_id LIMIT 128),
    candidates AS (SELECT * FROM recent UNION SELECT * FROM relevant)
    SELECT payload FROM candidates ORDER BY (actor_id=ANY($4::text[]) OR target_id=ANY($4::text[])) DESC NULLS LAST,observed_tick DESC,observation_id LIMIT 16`,
    [campaignId, npcId, m.observations.map((o) => o.id), subjects],
  );
  return rows.map((r) => r.payload as NpcObservation);
}

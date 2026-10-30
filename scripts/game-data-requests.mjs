/** Game extension of the explicit account export/purge transaction. No external calls. */
import { createHash, randomUUID } from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export function replaceActor(value, previous, replacement) {
  if (value === previous) return replacement;
  if (Array.isArray(value)) return value.map((v) => replaceActor(v, previous, replacement));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k === previous ? replacement : k,
        replaceActor(v, previous, replacement),
      ]),
    );
  return value;
}
export async function exportGameData(client, userId) {
  const rows = (
    await client.query(
      `SELECT c.id,c.playable_version,c.status,m.status AS membership,m.actor_id,c.state
    FROM game_campaigns c JOIN game_members m ON m.campaign_id=c.id WHERE m.user_id=$1`,
      [userId],
    )
  ).rows;
  // Account export is not permission to read other players' inventories or secret world state.
  return rows.map(({ state, actor_id, ...metadata }) => {
    const actor = state.entities[actor_id];
    return {
      ...metadata,
      actor: actor ? { id: actor.id, mapId: actor.mapId, x: actor.x, y: actor.y } : null,
      inventory: (actor?.inventory ?? []).map((id) => ({ id })),
    };
  });
}
export async function purgeGameData(client, userId) {
  const campaigns = (
    await client.query(
      `SELECT c.* FROM game_campaigns c
    WHERE c.owner_id=$1 OR EXISTS(SELECT 1 FROM game_members m WHERE m.campaign_id=c.id AND m.user_id=$1)
    ORDER BY c.id FOR UPDATE`,
      [userId],
    )
  ).rows;
  for (const campaign of campaigns) {
    const actorId = `player-${userId}`,
      replacement = `erased-${randomUUID()}`;
    const state = replaceActor(campaign.state, actorId, replacement);
    const actor = state.entities[replacement];
    if (actor) {
      for (const itemId of actor.inventory ?? []) {
        const item = state.entities[itemId];
        if (item?.ownerId === replacement) {
          delete item.ownerId;
          Object.assign(item, {
            mapId: actor.mapId,
            x: actor.x,
            y: actor.y,
            revision: item.revision + 1,
          });
        }
      }
      delete state.entities[replacement];
      for (const encounter of Object.values(state.encounters)) {
        encounter.participants = encounter.participants.filter((id) => id !== replacement);
        delete encounter.intents[replacement];
      }
      state.revision++;
    }
    // Immutable history has only fixture semantics in G0–G3; remove identifying actor IDs
    // while preserving other members' items and deterministic world outcomes.
    const events = (
      await client.query('SELECT sequence,payload FROM game_events WHERE campaign_id=$1', [
        campaign.id,
      ])
    ).rows;
    for (const event of events)
      await client.query('UPDATE game_events SET payload=$3 WHERE campaign_id=$1 AND sequence=$2', [
        campaign.id,
        event.sequence,
        replaceActor(event.payload, actorId, replacement),
      ]);
    await client.query('DELETE FROM game_operations WHERE campaign_id=$1 AND actor_id=$2', [
      campaign.id,
      actorId,
    ]);
    const operations = (
      await client.query(
        'SELECT actor_id,operation_id,result FROM game_operations WHERE campaign_id=$1',
        [campaign.id],
      )
    ).rows;
    for (const operation of operations)
      await client.query(
        'UPDATE game_operations SET result=$4 WHERE campaign_id=$1 AND actor_id=$2 AND operation_id=$3',
        [
          campaign.id,
          operation.actor_id,
          operation.operation_id,
          replaceActor(operation.result, actorId, replacement),
        ],
      );
    await client.query(
      "UPDATE game_campaigns SET state=$2,revision=revision+1,status=CASE WHEN owner_id=$3 THEN 'paused' ELSE status END WHERE id=$1",
      [campaign.id, state, userId],
    );
    const checksum = createHash('sha256')
      .update(JSON.stringify(canonical(state)))
      .digest('hex');
    await client.query('UPDATE game_snapshots SET state=$2,checksum=$3 WHERE campaign_id=$1', [
      campaign.id,
      state,
      checksum,
    ]);
  }
  await client.query('DELETE FROM game_members WHERE user_id=$1', [userId]);
}

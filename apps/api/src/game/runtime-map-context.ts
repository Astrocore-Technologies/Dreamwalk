import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { GameState } from '@dreamwalk/contracts';
import { runtimeMapView } from '@dreamwalk/game-core';
import { config } from '../config';
import { digest } from '../ai/context';
import { readRuntimeMapImage, runtimeMapImageSchema } from '../ai/runtime-vision';
import type { AiPurpose } from '../ai/types';
import { sourceAccessSql, sourceLiveSql } from './source-access';
import { renderRuntimeMapRaster } from './runtime-map-raster';

type Query = (sql: string, values: unknown[]) => Promise<Record<string, unknown>[]>;
/** Select only an immutable background the current scene can display. Never reads author drafts,
 * generation prompts, reference images, entity portraits, or another location's assets. */
async function currentRaster(query: Query, campaignId: string, state: GameState, actorId: string) {
  const actor = state.entities[actorId],
    map = actor && state.maps[actor.mapId];
  if (!map || !['player', 'npc'].includes(actor.kind)) throw new Error('MAP_VIEW_UNAVAILABLE');
  const player = actor.kind === 'player';
  const campaign = (
    await query(
      `SELECT c.source_version_id FROM game_campaigns c JOIN users owner ON owner.id=c.owner_id
     ${player ? "JOIN game_members m ON m.campaign_id=c.id AND m.actor_id=$2 AND m.status='accepted' JOIN users viewer ON viewer.id=m.user_id AND viewer.deleted_at IS NULL" : ''}
     WHERE c.id=$1 AND c.status='active' AND owner.deleted_at IS NULL AND ${player ? sourceAccessSql('m.user_id') : sourceLiveSql()}`,
      player ? [campaignId, actorId] : [campaignId],
    )
  )[0];
  if (!campaign) throw new Error('MAP_VIEW_UNAVAILABLE');
  const slot = `map:${map.id}:background`;
  const bound = state.artBindings?.find((b) => b.slot === slot);
  const illustration = map.backgroundMode === 'schematic' && !map.spatialGrounding;
  if (!bound && !illustration) return undefined;
  const rows = await query(
    `SELECT DISTINCT r.id AS "revisionId",r.sha256,r.mime,r.width,r.height,r.metadata,a.filename
     FROM art_asset_revisions r JOIN art_asset_families f ON f.id=r.family_id
     JOIN users u ON u.id=f.owner_id JOIN assets a ON a.id=r.upload_id
     WHERE u.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM art_asset_takedowns t WHERE t.revision_id=r.id)
     AND ($4::uuid IS NULL OR r.id=$4) AND
     (EXISTS(SELECT 1 FROM art_playable_pins p WHERE p.playable_version_id=$1 AND p.slot=$2 AND p.revision_id=r.id)
      OR ($4::uuid IS NOT NULL AND EXISTS(SELECT 1 FROM art_campaign_pins p WHERE p.campaign_id=$3 AND p.slot=$2 AND p.revision_id=r.id)))`,
    [
      campaign.source_version_id,
      slot,
      campaignId,
      illustration ? null : (bound?.revisionId ?? null),
    ],
  );
  if (rows.length !== 1) return undefined;
  const row = rows[0];
  if (!illustration && (row.revisionId !== bound?.revisionId || row.sha256 !== bound?.sha256))
    throw new Error('MAP_IMAGE_SOURCE_CHANGED');
  const meta = row.metadata as Record<string, unknown> | null;
  if (meta?.kind !== 'background' || !['top-down', 'unrestricted'].includes(String(meta.camera)))
    throw new Error('MAP_IMAGE_UNAVAILABLE');
  return row;
}
function observers(
  state: GameState,
  actorId: string,
  context: Record<string, unknown>,
  purpose: AiPurpose,
  npcId?: string,
) {
  if (purpose === 'plan') return [npcId ?? actorId];
  const director = (context.director ?? context) as Record<string, unknown>;
  const ids = new Set<string>([actorId, ...(npcId ? [npcId] : [])]);
  for (const id of (context.audienceIds ?? []) as string[]) ids.add(id);
  for (const d of (context.dialogues ?? []) as { audienceIds?: string[] }[])
    for (const id of d.audienceIds ?? []) ids.add(id);
  for (const a of (director.sharedAudience ?? []) as { id: string }[]) ids.add(a.id);
  // A shared image must not give an NPC voice the narrator's wider field of view.
  for (const speaker of (context.sceneSpeakers ?? []) as {
    npcId: string;
    audienceIds?: string[];
  }[]) {
    ids.add(speaker.npcId);
    for (const id of speaker.audienceIds ?? []) ids.add(id);
  }
  if ([...ids].some((id) => !state.entities[id])) throw new Error('MAP_VIEW_UNAVAILABLE');
  return [...ids].sort();
}
export async function extendRuntimeMap<T extends object>(
  db: { query: Query },
  campaignId: string,
  state: GameState,
  actorId: string,
  context: T,
  purpose: AiPurpose,
  npcId?: string,
): Promise<T> {
  if (!['plan', 'speech', 'story_turn', 'narrative', 'intent'].includes(purpose)) return context;
  const value = context as Record<string, unknown>;
  const view = runtimeMapView(state, observers(state, actorId, value, purpose, npcId));
  const row = await currentRaster(
    (sql, values) => db.query(sql, values),
    campaignId,
    state,
    actorId,
  );
  if (!row) return context;
  const filename = row.filename;
  if (typeof filename !== 'string' || basename(filename) !== filename)
    throw new Error('MAP_IMAGE_UNAVAILABLE');
  const bytes = await readFile(resolve(config.ASSET_DIR, filename));
  const runtimeMapImage = runtimeMapImageSchema.parse(
    await renderRuntimeMapRaster(
      bytes,
      { revisionId: String(row.revisionId), sha256: String(row.sha256) },
      view,
    ),
  );
  return { ...context, runtimeMapImage };
}
/** Recheck public positions, observer view, exact current-map pin and revocation before any dispatch.
 * Raster bytes stay frozen in the existing quote; a different image never triggers a hidden reprice. */
export async function runtimeMapStillCurrent(
  query: Query,
  campaignId: string,
  state: GameState,
  context: unknown,
) {
  const image = readRuntimeMapImage(context);
  if (!image) return true;
  try {
    if (digest(runtimeMapView(state, image.view.observerIds)) !== digest(image.view)) return false;
    const actorId =
      image.view.observerIds.find((id) => state.entities[id]?.kind === 'player') ??
      image.view.observerIds[0];
    const row = await currentRaster(query, campaignId, state, actorId);
    return row?.revisionId === image.revisionId && row.sha256 === image.sha256;
  } catch {
    return false;
  }
}

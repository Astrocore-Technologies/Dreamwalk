import { ownedCharacterPackage } from '../visual-authoring/character-package';
import type { VisualPackage, FrozenArtBinding, GameState } from '@dreamwalk/contracts';
import type { PoolClient } from 'pg';
import { heroSchema, type Hero } from '@dreamwalk/contracts';
import { fail } from '../errors';
export type SelectedHero = Omit<Hero, 'id' | 'createdAt' | 'updatedAt'> & {
  sourceUpdatedAt: string;
  visualPackage?: VisualPackage;
};
export async function readOwnedHero(
  c: PoolClient,
  userId: string,
  heroId?: string,
): Promise<SelectedHero | null> {
  if (!heroId) return null;
  const row = (
    await c.query('SELECT data,updated_at FROM heroes WHERE id=$1 AND owner_id=$2 FOR SHARE', [
      heroId,
      userId,
    ])
  ).rows[0];
  if (!row) fail(404, 'HERO_NOT_FOUND', 'HERO_NOT_FOUND');
  const data = heroSchema.parse(row.data);
  if (
    data.portraitAssetId &&
    !(
      await c.query(
        `SELECT a.id FROM assets a WHERE a.id=$1 AND a.owner_id=$2 AND NOT EXISTS(SELECT 1 FROM art_asset_revisions r JOIN art_asset_takedowns t ON t.revision_id=r.id WHERE r.upload_id=a.id) FOR SHARE OF a`,
        [data.portraitAssetId, userId],
      )
    ).rowCount
  )
    fail(409, 'HERO_PORTRAIT_UNAVAILABLE', 'HERO_PORTRAIT_UNAVAILABLE');
  const visual = data.characterPackageVersionId
    ? await ownedCharacterPackage(c, userId, data.characterPackageVersionId)
    : null;
  return {
    ...data,
    ...(visual ? { visualPackage: visual.manifest } : {}),
    sourceUpdatedAt: row.updated_at.toISOString(),
  };
}
export async function pinHero(
  c: PoolClient,
  campaignId: string,
  userId: string,
  heroId: string | undefined,
  snapshot: SelectedHero | null,
) {
  if (snapshot?.visualPackage) {
    const { parts } = await ownedCharacterPackage(c, userId, snapshot.visualPackage.id);
    const actor = (
      await c.query('SELECT actor_id FROM game_members WHERE campaign_id=$1 AND user_id=$2', [
        campaignId,
        userId,
      ])
    ).rows[0];
    for (const role of ['sheet', 'portrait']) {
      const part = snapshot.visualPackage.parts.find((p) => p.role === role)!;
      const row = parts.find((p) => p.id === part.revisionId)!;
      await c.query(
        'INSERT INTO art_campaign_pins(campaign_id,slot,revision_id,rights_snapshot) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [
          campaignId,
          `entity:${actor.actor_id}:${role === 'sheet' ? 'sprite' : 'portrait'}`,
          part.revisionId,
          JSON.stringify(row.metadata.rights),
        ],
      );
    }
  }
  await c.query(
    'INSERT INTO game_member_heroes(campaign_id,user_id,hero_id,snapshot) VALUES($1,$2,$3,$4)',
    [campaignId, userId, heroId ?? null, JSON.stringify(snapshot)],
  );
}

export function dressHero(state: GameState, actorId: string, snapshot: SelectedHero | null) {
  if (!snapshot) return;
  state.entities[actorId].label = snapshot.name;
  if (!snapshot.visualPackage) return;
  state.entities[actorId].characterAnimation = structuredClone(snapshot.visualPackage.animation!);
  const bindings: FrozenArtBinding[] = snapshot.visualPackage.parts
    .filter((p) => ['sheet', 'portrait'].includes(p.role))
    .map((p) => ({
      slot: `entity:${actorId}:${p.role === 'sheet' ? 'sprite' : 'portrait'}`,
      revisionId: p.revisionId,
      sha256: p.sha256,
      mime: 'image/webp',
      width: p.width,
      height: p.height,
    }));
  state.artBindings = [
    ...(state.artBindings ?? []).filter((b) => !bindings.some((n) => n.slot === b.slot)),
    ...bindings,
  ];
}

import type { PoolClient } from 'pg';
import { heroSchema, type Hero } from '@dreamwalk/contracts';
import { fail } from '../errors';
export type SelectedHero = Omit<Hero, 'id' | 'createdAt' | 'updatedAt'> & {
  sourceUpdatedAt: string;
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
  return { ...data, sourceUpdatedAt: row.updated_at.toISOString() };
}
export async function pinHero(
  c: PoolClient,
  campaignId: string,
  userId: string,
  heroId: string | undefined,
  snapshot: SelectedHero | null,
) {
  await c.query(
    'INSERT INTO game_member_heroes(campaign_id,user_id,hero_id,snapshot) VALUES($1,$2,$3,$4)',
    [campaignId, userId, heroId ?? null, JSON.stringify(snapshot)],
  );
}

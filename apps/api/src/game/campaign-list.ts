import { z } from 'zod';
import type { Db } from '../db';
import { sourceAccessSql } from './source-access';

/** Story saves span playable revisions, but retain membership and source-access checks. */
export async function listCampaigns(db: Pick<Db, 'query'>, userId: string, story?: unknown) {
  const adventureId = z.uuid().optional().parse(story);
  const rows = await db.query(
    `SELECT c.id,c.owner_id,c.playable_version,c.status,m.status AS membership,c.source_version_id,v.adventure_id,v.source_revision,c.created_at,c.updated_at,COALESCE(v.package->'compiled'->>'title',v.package->'source'->>'title') AS title FROM game_campaigns c JOIN game_members m ON m.campaign_id=c.id JOIN users owner ON owner.id=c.owner_id LEFT JOIN game_playable_versions v ON v.id=c.source_version_id WHERE m.user_id=$1 AND m.status IN ('accepted','pending') AND owner.deleted_at IS NULL AND ${sourceAccessSql('$1')}${adventureId ? " AND v.adventure_id=$2 AND c.status='active' AND m.status='accepted'" : ''} ORDER BY ${adventureId ? 'c.updated_at' : 'c.created_at'} DESC,c.id DESC LIMIT 100`,
    adventureId ? [userId, adventureId] : [userId],
  );
  return {
    userId,
    adventureId: adventureId ?? null,
    campaigns: rows.map((r) => ({
      id: r.id,
      ownerId: r.owner_id,
      playableVersion: r.playable_version,
      status: r.status,
      membership: r.membership,
      title: r.title ?? null,
      playableVersionId: r.source_version_id ?? null,
      adventureId: r.adventure_id ?? null,
      sourceRevision: r.source_revision ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  };
}

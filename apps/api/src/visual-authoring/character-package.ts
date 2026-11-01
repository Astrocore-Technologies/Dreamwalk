import { visualDigest } from './fingerprint';
import type { PoolClient } from 'pg';
import { characterAnimationSchema, type VisualPackage } from '@dreamwalk/contracts';
import { fail } from '../errors';
/** Revalidate availability at equip and campaign pin; photo/brief never enter the snapshot. */
export async function ownedCharacterPackage(c: PoolClient, userId: string, versionId: string) {
  const row = (
    await c.query(
      "SELECT manifest,plan,checksum FROM visual_package_versions WHERE id=$1 AND owner_id=$2 AND kind='character' FOR SHARE",
      [versionId, userId],
    )
  ).rows[0];
  if (!row) fail(404, 'ASSET_NOT_FOUND', 'ASSET_NOT_FOUND');
  const manifest = row.manifest as VisualPackage;
  if (visualDigest({ manifest, plan: row.plan }) !== row.checksum)
    fail(409, 'ASSET_INTEGRITY_FAILED', 'ASSET_INTEGRITY_FAILED');
  if (manifest.representation !== 'static') characterAnimationSchema.parse(manifest.animation);
  if (
    !(manifest.representation === 'static' ? ['sprite'] : ['concept', 'portrait', 'sheet']).every(
      (role) => manifest.parts.some((p) => p.role === role),
    )
  )
    fail(409, 'ART_UNAVAILABLE', 'ART_UNAVAILABLE');
  const ids = [...new Set(manifest.parts.map((p) => p.revisionId))];
  const parts = (
    await c.query(
      `SELECT r.*,a.owner_id FROM art_asset_revisions r JOIN assets a ON a.id=r.upload_id
     JOIN users u ON u.id=a.owner_id WHERE r.id=ANY($1::uuid[]) AND a.owner_id=$2 AND u.deleted_at IS NULL
     AND NOT EXISTS(SELECT 1 FROM art_asset_takedowns t WHERE t.revision_id=r.id) FOR SHARE OF r,a,u`,
      [ids, userId],
    )
  ).rows;
  if (
    parts.length !== ids.length ||
    parts.some((p) => !manifest.parts.some((m) => m.revisionId === p.id && m.sha256 === p.sha256))
  )
    fail(409, 'ART_UNAVAILABLE', 'ART_UNAVAILABLE');
  return { manifest, parts };
}

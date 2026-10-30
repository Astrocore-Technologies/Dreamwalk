import type { PoolClient } from 'pg';
/** Existing confirmed erasure pipeline owns the transaction, source tombstone and filesystem cleanup. */
export async function eraseReusableAssets(c: PoolClient, userId: string) {
  const permitted = (
    await c.query(
      "SELECT 1 FROM users WHERE id=$1 AND deleted_at IS NOT NULL AND current_setting('dreamwalk.erasure',true)='confirmed'",
      [userId],
    )
  ).rowCount;
  if (!permitted) throw new Error('CONFIRMED_ERASURE_REQUIRED');
  await c.query(
    "INSERT INTO art_asset_takedowns(revision_id,reason_code) SELECT r.id,'erasure' FROM art_asset_revisions r JOIN art_asset_families f ON f.id=r.family_id WHERE f.owner_id=$1 ON CONFLICT DO NOTHING",
    [userId],
  );
  await c.query(
    'UPDATE art_asset_revisions r SET metadata=\'{"erased":true}\' FROM art_asset_families f WHERE r.family_id=f.id AND f.owner_id=$1',
    [userId],
  );
  await c.query(
    'UPDATE art_playable_pins p SET rights_snapshot=\'{"erased":true}\' FROM art_asset_revisions r,art_asset_families f WHERE p.revision_id=r.id AND r.family_id=f.id AND f.owner_id=$1',
    [userId],
  );
  await c.query(
    'DELETE FROM art_story_asset_drafts d USING adventures a WHERE d.adventure_id=a.id AND a.owner_id=$1',
    [userId],
  );
  await c.query(
    `UPDATE art_playable_pins p SET slot='erased:'||encode(digest(p.slot,'sha256'),'hex'),rights_snapshot='{"erased":true}' FROM game_playable_versions v,adventures a WHERE p.playable_version_id=v.id AND v.adventure_id=a.id AND a.owner_id=$1 AND p.slot NOT LIKE 'erased:%'`,
    [userId],
  );
  await c.query(
    'UPDATE art_asset_families SET archived_at=COALESCE(archived_at,now()) WHERE owner_id=$1',
    [userId],
  );
  await c.query(
    'UPDATE art_asset_grants SET revoked_at=COALESCE(revoked_at,now()),grantee_id=CASE WHEN grantee_id=$1 THEN NULL ELSE grantee_id END WHERE grantor_id=$1 OR grantee_id=$1',
    [userId],
  );
  await c.query(
    "UPDATE art_asset_operations op SET result='{\"erased\":true}',request_hash='erased' WHERE user_id=$1 OR op.result->>'granteeUserId'=$1::text OR EXISTS(SELECT 1 FROM art_asset_revisions r JOIN art_asset_families f ON f.id=r.family_id WHERE f.owner_id=$1 AND strpos(op.result::text,r.id::text)>0)",
    [userId],
  );
}
export async function exportReusableAssets(c: PoolClient, userId: string) {
  return {
    revisions: (
      await c.query(
        'SELECT r.id,r.family_id,r.revision,r.metadata,r.sha256,r.width,r.height,r.created_at FROM art_asset_revisions r JOIN art_asset_families f ON f.id=r.family_id WHERE f.owner_id=$1 ORDER BY r.created_at',
        [userId],
      )
    ).rows,
    grants: (
      await c.query(
        'SELECT id,revision_id,grantor_id,grantee_id,retain_existing_pins,revoked_at,created_at FROM art_asset_grants WHERE grantor_id=$1 OR grantee_id=$1 ORDER BY created_at',
        [userId],
      )
    ).rows,
  };
}

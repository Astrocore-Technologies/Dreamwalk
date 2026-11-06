/** Clear derived text before source/membership redaction. No network or regeneration. */
export async function eraseTranslations(client, userId) {
  // This runs inside the existing source/user erasure transaction. Preserve only
  // financial usage/reservation and one-way attempt identity, never derived prose.
  await client.query(
    `UPDATE platform_content_translation_jobs SET context=NULL,result=NULL,erasure_user_ids='{}',
      field_path='',partition='erased',authority='erased',source_id=''
     WHERE $1=ANY(erasure_user_ids)`,
    [userId],
  );
  await client.query(
    'DELETE FROM platform_content_translation_cache WHERE $1=ANY(erasure_user_ids)',
    [userId],
  );
  await client.query(
    'DELETE FROM platform_content_translation_bindings WHERE $1=ANY(erasure_user_ids)',
    [userId],
  );
  // Keep the shared financial reservation/usage, never retained metadata prose.
  // A late provider receipt is allowed to settle cost but cannot restore this context/result.
  await client.query(
    `UPDATE platform_metadata_translation_jobs SET context=NULL,result=NULL,
      adventure_id=CASE WHEN adventure_id IN (SELECT id FROM adventures WHERE owner_id=$1) THEN NULL ELSE adventure_id END,
      requester_id=CASE WHEN requester_id=$1 THEN NULL ELSE requester_id END
     WHERE adventure_id IN (SELECT id FROM adventures WHERE owner_id=$1)
       OR (visibility='private' AND requester_id=$1)`,
    [userId],
  );
  await client.query(
    'UPDATE platform_metadata_translation_jobs SET requester_id=NULL WHERE requester_id=$1',
    [userId],
  );
  await client.query(
    `DELETE FROM content_translations WHERE viewer_id=$1
     OR adventure_id IN (SELECT id FROM adventures WHERE owner_id=$1)
     OR campaign_id IN (
       SELECT c.id FROM game_campaigns c WHERE c.owner_id=$1
       OR EXISTS(SELECT 1 FROM game_members m WHERE m.campaign_id=c.id AND m.user_id=$1)
       OR EXISTS(SELECT 1 FROM game_playable_versions v JOIN adventures a ON a.id=v.adventure_id
         WHERE v.id=c.source_version_id AND a.owner_id=$1)
     )`,
    [userId],
  );
}

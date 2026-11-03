/** Clear derived text before source/membership redaction. No network or regeneration. */
export async function eraseTranslations(client, userId) {
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

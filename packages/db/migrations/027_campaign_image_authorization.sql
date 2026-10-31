-- Campaign image context is stored in the immutable quoted input. Revocation
-- invalidates outstanding consent even when an invitation is later restored.
CREATE FUNCTION cancel_campaign_image_context() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE campaign_ids uuid[];
BEGIN
 IF TG_TABLE_NAME='game_members' THEN
  IF NEW.status='accepted' THEN RETURN NEW; END IF;
  campaign_ids := ARRAY[NEW.campaign_id];
 ELSIF TG_TABLE_NAME='adventure_invitations' THEN
  IF NEW.status='accepted' THEN RETURN NEW; END IF;
  SELECT array_agg(c.id) INTO campaign_ids FROM game_campaigns c
   JOIN game_playable_versions v ON v.id=c.source_version_id
   WHERE v.adventure_id=NEW.adventure_id AND c.owner_id=NEW.recipient_id;
 ELSIF TG_TABLE_NAME='adventures' THEN
  IF NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.visibility IS NOT DISTINCT FROM OLD.visibility
   AND NEW.owner_id=OLD.owner_id AND NEW.published_snapshot IS NOT DISTINCT FROM OLD.published_snapshot THEN RETURN NEW; END IF;
  -- Conservative invalidation on source publication/access changes; a fresh quote
  -- is required, but already admitted requester-owned art remains immutable.
  SELECT array_agg(c.id) INTO campaign_ids FROM game_campaigns c
   JOIN game_playable_versions v ON v.id=c.source_version_id WHERE v.adventure_id=NEW.id;
 END IF;
 UPDATE image_generation_quotes SET expires_at=least(expires_at,now())
  WHERE input->'campaignContext'->>'campaignId'=ANY(SELECT x::text FROM unnest(campaign_ids) x);
 UPDATE image_generation_jobs SET cancel_requested=true,quota_reserved_bytes=0,
  error_code='AUTHORIZATION_REVOKED',updated_at=now()
  WHERE input->'campaignContext'->>'campaignId'=ANY(SELECT x::text FROM unnest(campaign_ids) x)
    AND status<>'admitted';
 RETURN NEW;
END $$;
CREATE TRIGGER campaign_image_member_revoke AFTER UPDATE OF status ON game_members
 FOR EACH ROW EXECUTE FUNCTION cancel_campaign_image_context();
CREATE TRIGGER campaign_image_invitation_revoke AFTER UPDATE OF status ON adventure_invitations
 FOR EACH ROW EXECUTE FUNCTION cancel_campaign_image_context();
CREATE TRIGGER campaign_image_source_change AFTER UPDATE OF status,visibility,owner_id,published_snapshot ON adventures
 FOR EACH ROW EXECUTE FUNCTION cancel_campaign_image_context();

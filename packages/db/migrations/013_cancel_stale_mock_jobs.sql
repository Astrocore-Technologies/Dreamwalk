-- Revocation cancels only pending authored decisions, not already accepted world effects.
CREATE FUNCTION cancel_source_mock_jobs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.visibility IS DISTINCT FROM OLD.visibility
 OR (NEW.status='archived' AND OLD.status IS DISTINCT FROM NEW.status)
 OR (OLD.published_snapshot IS NOT NULL AND NEW.published_snapshot IS NULL)
 THEN
  UPDATE game_npc_jobs j SET status='cancelled',result_code='SOURCE_UNAVAILABLE',completed_at=now()
  FROM game_campaigns c JOIN game_playable_versions v ON v.id=c.source_version_id
  WHERE j.campaign_id=c.id AND v.adventure_id=NEW.id AND j.status='queued';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER cancel_source_pending_mock_jobs AFTER UPDATE OF visibility,status,published_snapshot ON adventures FOR EACH ROW EXECUTE FUNCTION cancel_source_mock_jobs();
CREATE FUNCTION cancel_invitee_mock_jobs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status='accepted' AND NEW.status<>'accepted' THEN
  UPDATE game_npc_jobs j SET status='cancelled',result_code='SOURCE_ACCESS_REVOKED',completed_at=now()
  FROM game_campaigns c JOIN game_playable_versions v ON v.id=c.source_version_id
  WHERE j.campaign_id=c.id AND v.adventure_id=NEW.adventure_id AND j.requester_actor_id='player-'||NEW.recipient_id::text AND j.status='queued';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER cancel_invitee_pending_mock_jobs AFTER UPDATE OF status ON adventure_invitations FOR EACH ROW EXECUTE FUNCTION cancel_invitee_mock_jobs();

CREATE TABLE npc_ai_sponsors (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), campaign_id uuid NOT NULL REFERENCES game_campaigns(id),
 payer_user_id uuid REFERENCES users(id), operation_id uuid NOT NULL, request_hash text NOT NULL,
 total_credits integer NOT NULL CHECK(total_credits>=0), per_operation_credits integer NOT NULL CHECK(per_operation_credits>=0),
 max_operations integer NOT NULL CHECK(max_operations BETWEEN 1 AND 1000),
 total_provider_micros bigint NOT NULL CHECK(total_provider_micros>=0), per_operation_provider_micros bigint NOT NULL CHECK(per_operation_provider_micros>=0),
 purposes text[] NOT NULL, provider_id text NOT NULL, provider_version text NOT NULL, policy_version text NOT NULL,
 expires_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(campaign_id,operation_id)
);
CREATE UNIQUE INDEX npc_ai_one_sponsor ON npc_ai_sponsors(campaign_id) WHERE revoked_at IS NULL;
ALTER TABLE npc_ai_jobs ADD COLUMN sponsor_id uuid REFERENCES npc_ai_sponsors(id);
CREATE INDEX npc_ai_sponsored_jobs ON npc_ai_jobs(sponsor_id);
-- Existing cancel_npc_ai_* triggers lock/cancel jobs first; z_ ordering then invalidates consent permanently.
CREATE FUNCTION revoke_npc_ai_sponsors() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='game_members' THEN
  IF OLD.status='accepted' AND NEW.status<>'accepted' THEN
   UPDATE npc_ai_sponsors SET revoked_at=COALESCE(revoked_at,now()) WHERE campaign_id=NEW.campaign_id;
  END IF;
 ELSIF TG_TABLE_NAME='users' THEN
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
   UPDATE npc_ai_sponsors SET revoked_at=COALESCE(revoked_at,now()) WHERE payer_user_id=NEW.id OR campaign_id IN (SELECT id FROM game_campaigns WHERE owner_id=NEW.id);
  END IF;
 ELSIF TG_TABLE_NAME='adventure_invitations' THEN
  IF OLD.status='accepted' AND NEW.status<>'accepted' THEN
   UPDATE npc_ai_sponsors SET revoked_at=COALESCE(revoked_at,now()) WHERE campaign_id IN
    (SELECT c.id FROM game_campaigns c JOIN game_playable_versions v ON v.id=c.source_version_id WHERE v.adventure_id=NEW.adventure_id);
  END IF;
 ELSIF TG_TABLE_NAME='adventures' THEN
  IF NEW.visibility IS DISTINCT FROM OLD.visibility OR NEW.status='archived' OR (OLD.published_snapshot IS NOT NULL AND NEW.published_snapshot IS NULL) THEN
   UPDATE npc_ai_sponsors SET revoked_at=COALESCE(revoked_at,now()) WHERE campaign_id IN
    (SELECT c.id FROM game_campaigns c JOIN game_playable_versions v ON v.id=c.source_version_id WHERE v.adventure_id=NEW.id);
  END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER z_revoke_npc_ai_sponsor_member AFTER UPDATE OF status ON game_members FOR EACH ROW EXECUTE FUNCTION revoke_npc_ai_sponsors();
CREATE TRIGGER z_revoke_npc_ai_sponsor_user AFTER UPDATE OF deleted_at ON users FOR EACH ROW EXECUTE FUNCTION revoke_npc_ai_sponsors();
CREATE TRIGGER z_revoke_npc_ai_sponsor_invitation AFTER UPDATE OF status ON adventure_invitations FOR EACH ROW EXECUTE FUNCTION revoke_npc_ai_sponsors();
CREATE TRIGGER z_revoke_npc_ai_sponsor_source AFTER UPDATE OF visibility,status,published_snapshot ON adventures FOR EACH ROW EXECUTE FUNCTION revoke_npc_ai_sponsors();

ALTER TABLE npc_ai_jobs ADD COLUMN subject_kind text NOT NULL DEFAULT 'npc' CHECK(subject_kind IN ('npc','player'));
ALTER TABLE npc_ai_jobs DROP CONSTRAINT npc_ai_jobs_purpose_check;
ALTER TABLE npc_ai_jobs ADD CHECK(purpose IN ('plan','summary','speech','intent'));
ALTER TABLE npc_ai_quotes DROP CONSTRAINT npc_ai_quotes_purpose_check;
ALTER TABLE npc_ai_quotes ADD CHECK(purpose IN ('plan','summary','speech','intent'));

ALTER TABLE npc_ai_jobs ADD COLUMN provider_cost_evidence text NOT NULL DEFAULT 'unknown' CHECK(provider_cost_evidence IN ('unknown','reported','configured_rates'));
CREATE FUNCTION revoke_deleted_npc_ai_sponsors() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='game_members' THEN
  UPDATE npc_ai_jobs SET cancel_requested=true,result_code='MEMBERSHIP_DELETED' WHERE campaign_id=OLD.campaign_id AND status NOT IN ('committed','stale','cancelled','failed');
  UPDATE npc_ai_sponsors SET revoked_at=COALESCE(revoked_at,now()) WHERE campaign_id=OLD.campaign_id;
  DELETE FROM npc_ai_cache WHERE campaign_id=OLD.campaign_id;
 ELSE
  UPDATE npc_ai_jobs j SET cancel_requested=true,result_code='SOURCE_INVITATION_DELETED' FROM game_campaigns c JOIN game_playable_versions v ON v.id=c.source_version_id WHERE j.campaign_id=c.id AND v.adventure_id=OLD.adventure_id AND j.status NOT IN ('committed','stale','cancelled','failed');
  UPDATE npc_ai_sponsors SET revoked_at=COALESCE(revoked_at,now()) WHERE campaign_id IN (SELECT c.id FROM game_campaigns c JOIN game_playable_versions v ON v.id=c.source_version_id WHERE v.adventure_id=OLD.adventure_id);
  DELETE FROM npc_ai_cache k USING game_campaigns c,game_playable_versions v WHERE k.campaign_id=c.id AND c.source_version_id=v.id AND v.adventure_id=OLD.adventure_id;
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER revoke_deleted_npc_ai_member AFTER DELETE ON game_members FOR EACH ROW EXECUTE FUNCTION revoke_deleted_npc_ai_sponsors();
CREATE TRIGGER revoke_deleted_npc_ai_invitation AFTER DELETE ON adventure_invitations FOR EACH ROW EXECUTE FUNCTION revoke_deleted_npc_ai_sponsors();

CREATE TABLE game_npc_decision_requests (
 id uuid PRIMARY KEY,
 campaign_id uuid NOT NULL REFERENCES game_campaigns(id) ON DELETE CASCADE,
 npc_id text NOT NULL,
 purpose text NOT NULL CHECK(purpose IN ('plan','summary','speech','intent')),
 cause_key text NOT NULL,
 requester_user_id uuid REFERENCES users(id),
 recipient_actor_id text,
 context jsonb NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','scheduled','fallback','cancelled','failed')),
 job_id uuid REFERENCES npc_ai_jobs(id),
 result_code text,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(campaign_id,npc_id,purpose,cause_key)
);
CREATE INDEX game_npc_decision_requests_pending ON game_npc_decision_requests(campaign_id,status,created_at);
CREATE TABLE game_party_chat (
 id uuid PRIMARY KEY,
 campaign_id uuid NOT NULL REFERENCES game_campaigns(id) ON DELETE CASCADE,
 sender_user_id uuid NOT NULL REFERENCES users(id),
 sender_actor_id text NOT NULL,
 operation_id uuid NOT NULL,
 text text NOT NULL CHECK(char_length(text) BETWEEN 1 AND 1000),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(campaign_id,sender_user_id,operation_id)
);
CREATE INDEX game_party_chat_recent ON game_party_chat(campaign_id,created_at DESC);
-- Requests cannot survive authorization loss and later silently resurrect after regrant.
CREATE FUNCTION cancel_npc_runtime_member_requests() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE game_npc_decision_requests SET status='cancelled',context='{}',result_code='AUTHORIZATION_REVOKED'
 WHERE campaign_id=OLD.campaign_id AND status IN ('queued','scheduled');
 RETURN NULL;
END $$;
CREATE TRIGGER npc_runtime_member_request_delete AFTER DELETE ON game_members
 FOR EACH ROW EXECUTE FUNCTION cancel_npc_runtime_member_requests();
CREATE TRIGGER npc_runtime_member_request_revoke AFTER UPDATE OF status ON game_members
 FOR EACH ROW WHEN(OLD.status='accepted' AND NEW.status<>'accepted') EXECUTE FUNCTION cancel_npc_runtime_member_requests();
CREATE FUNCTION cancel_npc_runtime_source_requests() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.visibility IS DISTINCT FROM OLD.visibility OR (NEW.status='archived' AND OLD.status IS DISTINCT FROM NEW.status) OR (OLD.published_snapshot IS NOT NULL AND NEW.published_snapshot IS NULL) THEN
 UPDATE game_npc_decision_requests r SET status='cancelled',context='{}',result_code='SOURCE_UNAVAILABLE'
 FROM game_campaigns c JOIN game_playable_versions v ON v.id=c.source_version_id
 WHERE r.campaign_id=c.id AND v.adventure_id=NEW.id AND r.status IN ('queued','scheduled');
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER cancel_npc_runtime_source_requests AFTER UPDATE OF visibility,status,published_snapshot ON adventures FOR EACH ROW EXECUTE FUNCTION cancel_npc_runtime_source_requests();
CREATE FUNCTION cancel_npc_runtime_invitation_requests() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status='accepted' AND NEW.status<>'accepted' THEN
 UPDATE game_npc_decision_requests r SET status='cancelled',context='{}',result_code='SOURCE_ACCESS_REVOKED'
 FROM game_campaigns c JOIN game_playable_versions v ON v.id=c.source_version_id
 WHERE r.campaign_id=c.id AND v.adventure_id=NEW.adventure_id AND r.status IN ('queued','scheduled');
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER cancel_npc_runtime_invitation_requests AFTER UPDATE OF status ON adventure_invitations FOR EACH ROW EXECUTE FUNCTION cancel_npc_runtime_invitation_requests();
CREATE FUNCTION cancel_npc_runtime_user_requests() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
 UPDATE game_npc_decision_requests SET status='cancelled',context='{}',result_code='USER_DELETED'
 WHERE status IN ('queued','scheduled') AND (requester_user_id=NEW.id OR campaign_id IN(SELECT campaign_id FROM game_members WHERE user_id=NEW.id));
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER cancel_npc_runtime_user_requests AFTER UPDATE OF deleted_at ON users FOR EACH ROW EXECUTE FUNCTION cancel_npc_runtime_user_requests();

CREATE FUNCTION cancel_linked_runtime_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  UPDATE npc_ai_jobs SET cancel_requested=true,result_code='RUNTIME_REQUEST_REVOKED' WHERE id=OLD.job_id AND status NOT IN ('committed','stale','cancelled','failed');
  RETURN OLD;
 END IF;
 IF NEW.status='cancelled' THEN
  UPDATE npc_ai_jobs SET cancel_requested=true,result_code='RUNTIME_REQUEST_REVOKED' WHERE id=NEW.job_id AND status NOT IN ('committed','stale','cancelled','failed');
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cancel_linked_runtime_job_update AFTER UPDATE OF status ON game_npc_decision_requests FOR EACH ROW WHEN(NEW.status='cancelled') EXECUTE FUNCTION cancel_linked_runtime_job();
CREATE TRIGGER cancel_linked_runtime_job_delete BEFORE DELETE ON game_npc_decision_requests FOR EACH ROW EXECUTE FUNCTION cancel_linked_runtime_job();

-- Invalidate pre-upgrade quotes rather than dispatch under an unquoted provider contract.
ALTER TABLE npc_ai_quotes ADD COLUMN provider_version text NOT NULL DEFAULT 'legacy-invalidated';
ALTER TABLE npc_ai_jobs DROP CONSTRAINT npc_ai_jobs_purpose_check;
ALTER TABLE npc_ai_jobs ADD CONSTRAINT npc_ai_jobs_purpose_check CHECK(purpose IN ('plan','summary','speech','intent','supporting_npc','narrative','story_turn'));
ALTER TABLE npc_ai_quotes DROP CONSTRAINT npc_ai_quotes_purpose_check;
ALTER TABLE npc_ai_quotes ADD CONSTRAINT npc_ai_quotes_purpose_check CHECK(purpose IN ('plan','summary','speech','intent','supporting_npc','narrative','story_turn'));
ALTER TABLE game_npc_decision_requests DROP CONSTRAINT game_npc_decision_requests_purpose_check;
ALTER TABLE game_npc_decision_requests ADD CONSTRAINT game_npc_decision_requests_purpose_check CHECK(purpose IN ('plan','summary','speech','intent','supporting_npc','narrative','story_turn'));
CREATE TABLE game_story_turns (
 id uuid PRIMARY KEY, campaign_id uuid NOT NULL REFERENCES game_campaigns(id),
 requester_user_id uuid NOT NULL REFERENCES users(id), actor_id text NOT NULL,
 operation_id uuid NOT NULL, request_hash text NOT NULL,
 input jsonb NOT NULL, segments jsonb NOT NULL, context jsonb NOT NULL,
 quote_id uuid, quote_result jsonb,
 decision_request_id uuid UNIQUE REFERENCES game_npc_decision_requests(id) ON DELETE SET NULL,
 confirmed_action_hash text, proposal jsonb, proposal_hash text,
 status text NOT NULL CHECK(status IN ('quoted','queued','awaiting_confirmation','committed','clarification','stale','failed','declined')),
 result_code text, result jsonb,
 valid_until_tick bigint, submitted_sequence bigint, committed_sequence bigint,
 confirmation_operation_id uuid, confirmation_request_hash text,
 created_at timestamptz NOT NULL DEFAULT now(), submitted_at timestamptz, committed_at timestamptz,
 erased_at timestamptz,
 UNIQUE(campaign_id,requester_user_id,operation_id)
);
CREATE INDEX story_turn_actor_status ON game_story_turns(campaign_id,requester_user_id,status,created_at);
CREATE TABLE game_story_feed (
 id uuid PRIMARY KEY, turn_id uuid NOT NULL REFERENCES game_story_turns(id),
 campaign_id uuid NOT NULL REFERENCES game_campaigns(id),
 sequence bigint NOT NULL, ordinal integer NOT NULL CHECK(ordinal>=0),
 tick bigint NOT NULL, channel text NOT NULL CHECK(channel IN ('say','whisper')),
 audience_ids text[] NOT NULL, entry jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(turn_id,ordinal)
);
CREATE INDEX story_feed_campaign_order ON game_story_feed(campaign_id,sequence,ordinal);
-- Pending consent cannot resurrect after revoke/reinvite. Conservative campaign
-- cancellation is preferable to carrying another member's stale private context.
CREATE FUNCTION cancel_story_turn_consent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ids uuid[];
BEGIN
 IF TG_TABLE_NAME='game_members' THEN
  IF TG_OP='UPDATE' AND NEW.status='accepted' THEN RETURN NULL; END IF;
  ids:=ARRAY[OLD.campaign_id];
 ELSIF TG_TABLE_NAME='adventure_invitations' THEN
  IF NEW.status='accepted' THEN RETURN NEW; END IF;
  SELECT array_agg(c.id) INTO ids FROM game_campaigns c JOIN game_playable_versions v ON v.id=c.source_version_id WHERE v.adventure_id=NEW.adventure_id;
 ELSIF TG_TABLE_NAME='adventures' THEN
  IF NEW.visibility IS NOT DISTINCT FROM OLD.visibility AND NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.owner_id=OLD.owner_id AND NEW.published_snapshot IS NOT DISTINCT FROM OLD.published_snapshot THEN RETURN NEW; END IF;
  SELECT array_agg(c.id) INTO ids FROM game_campaigns c JOIN game_playable_versions v ON v.id=c.source_version_id WHERE v.adventure_id=NEW.id;
 ELSIF TG_TABLE_NAME='users' THEN
  IF NEW.deleted_at IS NULL THEN RETURN NEW; END IF;
  SELECT array_agg(m.campaign_id) INTO ids FROM game_members m WHERE m.user_id=NEW.id;
 END IF;
 UPDATE game_story_turns SET status='failed',result_code='AUTHORIZATION_REVOKED',context='{}',proposal=NULL
 WHERE campaign_id=ANY(ids) AND status IN ('quoted','queued','awaiting_confirmation');
 UPDATE game_npc_decision_requests SET status='cancelled',context='{}',result_code='AUTHORIZATION_REVOKED'
 WHERE campaign_id=ANY(ids) AND purpose='story_turn' AND status IN ('queued','scheduled');
 RETURN NULL;
END $$;
CREATE TRIGGER story_turn_member_revoke AFTER UPDATE OF status OR DELETE ON game_members FOR EACH ROW EXECUTE FUNCTION cancel_story_turn_consent();
CREATE TRIGGER story_turn_invitation_revoke AFTER UPDATE OF status ON adventure_invitations FOR EACH ROW EXECUTE FUNCTION cancel_story_turn_consent();
CREATE TRIGGER story_turn_source_change AFTER UPDATE OF status,visibility,owner_id,published_snapshot ON adventures FOR EACH ROW EXECUTE FUNCTION cancel_story_turn_consent();
CREATE TRIGGER story_turn_user_delete AFTER UPDATE OF deleted_at ON users FOR EACH ROW EXECUTE FUNCTION cancel_story_turn_consent();

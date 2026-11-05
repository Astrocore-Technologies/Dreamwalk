-- A new End turn policy explicitly includes one optional bounded utterance per planned NPC.
-- Old rounds and accepted quotes retain their original scope.
ALTER TABLE game_ordinary_round_consents ADD COLUMN policy_version text CHECK(policy_version IS NULL OR policy_version='bounded-npc-speech-v1');
ALTER TABLE game_world_generation_batches ADD COLUMN autonomous_speech_entries jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(autonomous_speech_entries)='array');
CREATE TABLE game_autonomous_speech_bindings (
 batch_id uuid NOT NULL REFERENCES game_world_generation_batches(id) ON DELETE CASCADE,
 npc_id text NOT NULL,
 source_request_id uuid NOT NULL REFERENCES game_npc_decision_requests(id) ON DELETE CASCADE,
 request_id uuid NOT NULL UNIQUE REFERENCES game_npc_decision_requests(id) ON DELETE CASCADE,
 context_digest text NOT NULL,
 native_quote_id uuid NOT NULL UNIQUE REFERENCES npc_ai_quotes(id),
 quote jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(batch_id,npc_id),
 UNIQUE(batch_id,source_request_id)
);
CREATE FUNCTION preserve_autonomous_speech_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'AUTONOMOUS_SPEECH_BINDING_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER autonomous_speech_binding_immutable BEFORE UPDATE ON game_autonomous_speech_bindings FOR EACH ROW EXECUTE FUNCTION preserve_autonomous_speech_binding();
CREATE FUNCTION preserve_accepted_world_speech_allowance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.accepted_at IS NOT NULL AND (jsonb_array_length(OLD.autonomous_speech_entries)>0 OR jsonb_array_length(NEW.autonomous_speech_entries)>0)
 AND (NEW.autonomous_speech_entries IS DISTINCT FROM OLD.autonomous_speech_entries OR
     NEW.entries IS DISTINCT FROM OLD.entries OR NEW.media_entries IS DISTINCT FROM OLD.media_entries OR
     NEW.turn_fence IS DISTINCT FROM OLD.turn_fence OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR
     NEW.campaign_id IS DISTINCT FROM OLD.campaign_id OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at OR
     NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.quote IS DISTINCT FROM OLD.quote) THEN
   RAISE EXCEPTION 'WORLD_BATCH_CONSENT_IMMUTABLE';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER accepted_world_speech_allowance_immutable BEFORE UPDATE ON game_world_generation_batches FOR EACH ROW EXECUTE FUNCTION preserve_accepted_world_speech_allowance();

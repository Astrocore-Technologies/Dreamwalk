-- Add ordinary per-account admission; historical grants/reserves are never rewritten.
ALTER TABLE live_test_sessions DROP CONSTRAINT live_test_sessions_mode_check;
ALTER TABLE live_test_sessions ADD CONSTRAINT live_test_sessions_mode_check CHECK(mode IN ('manual','owner','release'));
ALTER TABLE live_test_sessions DROP CONSTRAINT generation_authorization_mode;
ALTER TABLE live_test_sessions ADD CONSTRAINT generation_authorization_mode CHECK(
 (mode='manual' AND expires_at IS NOT NULL AND config_hash IS NULL AND owner_handle IS NULL AND cap_micros=1000000 AND text_cap_micros IS NULL AND image_cap_micros IS NULL)
 OR (mode='owner' AND expires_at IS NULL AND config_hash IS NOT NULL AND config_hash ~ '^[a-f0-9]{64}$' AND owner_handle IS NOT NULL AND text_cap_micros IS NOT NULL AND text_cap_micros>0 AND image_cap_micros IS NOT NULL AND image_cap_micros>0)
 OR (mode='release' AND expires_at IS NULL AND config_hash IS NOT NULL AND config_hash ~ '^[a-f0-9]{64}$' AND owner_handle IS NULL AND text_cap_micros IS NOT NULL AND text_cap_micros>0 AND image_cap_micros IS NOT NULL AND image_cap_micros>0 AND scope_id='release:'||owner_id::text)
);
CREATE UNIQUE INDEX generation_one_release_policy_per_actor ON live_test_sessions(owner_id) WHERE mode='release';
CREATE UNIQUE INDEX generation_one_release_policy_per_scope ON live_test_sessions(scope_id) WHERE mode='release';

-- Ordinary NPC requests share the same immutable financial receipt as images/authoring.
ALTER TABLE npc_ai_jobs ADD COLUMN generation_reservation_id uuid REFERENCES generation_budget_reservations(id);
CREATE UNIQUE INDEX npc_release_reservation_unique ON npc_ai_jobs(generation_reservation_id) WHERE generation_reservation_id IS NOT NULL;

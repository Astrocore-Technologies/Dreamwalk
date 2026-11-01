-- Generalize authorization identity without replacing historical financial records.
-- The old table name is retained for existing foreign keys and erasure/export tooling.
ALTER TABLE live_test_sessions ADD COLUMN mode text NOT NULL DEFAULT 'manual' CHECK(mode IN ('manual','owner'));
ALTER TABLE live_test_sessions ADD COLUMN config_hash text;
ALTER TABLE live_test_sessions ADD COLUMN owner_handle text;
ALTER TABLE live_test_sessions ADD COLUMN text_cap_micros bigint;
ALTER TABLE live_test_sessions ADD COLUMN image_cap_micros bigint;
ALTER TABLE live_test_sessions ALTER COLUMN expires_at DROP NOT NULL;
ALTER TABLE live_test_sessions DROP CONSTRAINT live_test_sessions_scope_id_key;
ALTER TABLE live_test_sessions DROP CONSTRAINT live_test_sessions_cap_micros_check;
ALTER TABLE live_test_sessions ADD CONSTRAINT generation_cap_positive CHECK(cap_micros>0);
ALTER TABLE live_test_sessions ADD CONSTRAINT generation_authorization_mode CHECK(
 (mode='manual' AND expires_at IS NOT NULL AND config_hash IS NULL AND owner_handle IS NULL AND cap_micros=1000000 AND text_cap_micros IS NULL AND image_cap_micros IS NULL)
 OR (mode='owner' AND expires_at IS NULL AND config_hash IS NOT NULL AND config_hash ~ '^[a-f0-9]{64}$' AND owner_handle IS NOT NULL AND text_cap_micros IS NOT NULL AND text_cap_micros>0 AND image_cap_micros IS NOT NULL AND image_cap_micros>0)
);
CREATE UNIQUE INDEX generation_one_manual_grant_per_scope ON live_test_sessions(scope_id) WHERE mode='manual';
CREATE UNIQUE INDEX generation_one_owner_policy_per_scope ON live_test_sessions(scope_id) WHERE mode='owner';
-- No expiry, state, cost, reservation or ownership is rewritten by this migration.

-- Quotes pin a finite profile-specific reserve; historical values stay unchanged.
ALTER TABLE live_authoring_text_quotes DROP CONSTRAINT live_authoring_text_quotes_upper_micros_check;
ALTER TABLE live_authoring_text_quotes ALTER COLUMN upper_micros DROP DEFAULT;
ALTER TABLE live_authoring_text_quotes ADD CONSTRAINT authoring_quote_positive_upper CHECK(upper_micros>0);

-- Preserve unknown historical provenance; new jobs explicitly distinguish free mocks.
ALTER TABLE npc_ai_jobs ADD COLUMN provider_external boolean;
ALTER TABLE npc_ai_jobs ADD COLUMN generation_authorization_id uuid REFERENCES live_test_sessions(id) ON DELETE SET NULL;
CREATE INDEX npc_jobs_generation_authorization ON npc_ai_jobs(generation_authorization_id) WHERE generation_authorization_id IS NOT NULL;
CREATE INDEX npc_permits_job ON live_test_text_permits(job_id) WHERE job_id IS NOT NULL;

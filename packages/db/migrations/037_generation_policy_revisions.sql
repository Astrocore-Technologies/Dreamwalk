-- Reviewed policy changes append to the same authorization and financial scope.
ALTER TABLE live_test_sessions ADD COLUMN policy_revision integer NOT NULL DEFAULT 0 CHECK(policy_revision>=0);
ALTER TABLE live_test_sessions ADD COLUMN policy_hash text CHECK(policy_hash IS NULL OR policy_hash ~ '^[a-f0-9]{64}$');
CREATE TABLE generation_policy_revisions (
 id uuid PRIMARY KEY,authorization_id uuid NOT NULL REFERENCES live_test_sessions(id),
 scope_id text NOT NULL REFERENCES generation_budget_scopes(id),revision integer NOT NULL CHECK(revision>0),
 profile_hash text NOT NULL CHECK(profile_hash ~ '^[a-f0-9]{64}$'),
 config_fingerprint text NOT NULL CHECK(config_fingerprint ~ '^[a-f0-9]{64}$'),
 previous_hash text CHECK(previous_hash IS NULL OR previous_hash ~ '^[a-f0-9]{64}$'),
 profile_snapshot jsonb NOT NULL CHECK(jsonb_typeof(profile_snapshot)='object'),
 operation_id uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 acknowledged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(authorization_id,revision),UNIQUE(authorization_id,operation_id)
);
CREATE INDEX generation_policy_history_scope ON generation_policy_revisions(scope_id,revision);
CREATE FUNCTION generation_policy_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Immutable generation policy revision'; END $$;
CREATE TRIGGER generation_policy_revision_guard BEFORE UPDATE OR DELETE ON generation_policy_revisions
 FOR EACH ROW EXECUTE FUNCTION generation_policy_revision_immutable();
-- NULL preserves honest historical unavailability; no legacy price/profile is invented.
ALTER TABLE image_generation_quotes ADD COLUMN estimate_snapshot jsonb;
ALTER TABLE image_generation_quotes ADD COLUMN pricing_profile_snapshot jsonb;
ALTER TABLE image_generation_quotes ADD COLUMN generation_policy_revision integer CHECK(generation_policy_revision IS NULL OR generation_policy_revision>=0);
ALTER TABLE image_generation_quotes ADD COLUMN generation_policy_hash text CHECK(generation_policy_hash IS NULL OR generation_policy_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE image_generation_jobs ADD COLUMN estimate_snapshot jsonb;
ALTER TABLE image_generation_jobs ADD COLUMN pricing_profile_snapshot jsonb;
ALTER TABLE image_generation_jobs ADD COLUMN generation_policy_revision integer CHECK(generation_policy_revision IS NULL OR generation_policy_revision>=0);
ALTER TABLE image_generation_jobs ADD COLUMN generation_policy_hash text CHECK(generation_policy_hash IS NULL OR generation_policy_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE live_test_text_permits ADD COLUMN request_snapshot jsonb;
ALTER TABLE live_test_text_permits ADD COLUMN generation_policy_revision integer CHECK(generation_policy_revision IS NULL OR generation_policy_revision>=0);
ALTER TABLE live_test_text_permits ADD COLUMN generation_policy_hash text CHECK(generation_policy_hash IS NULL OR generation_policy_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE live_authoring_text_quotes ADD COLUMN request_snapshot jsonb;
ALTER TABLE live_authoring_text_quotes ADD COLUMN generation_policy_revision integer CHECK(generation_policy_revision IS NULL OR generation_policy_revision>=0);
ALTER TABLE live_authoring_text_quotes ADD COLUMN generation_policy_hash text CHECK(generation_policy_hash IS NULL OR generation_policy_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE live_authoring_text_jobs ADD COLUMN request_snapshot jsonb;
ALTER TABLE live_authoring_text_jobs ADD COLUMN generation_policy_revision integer CHECK(generation_policy_revision IS NULL OR generation_policy_revision>=0);
ALTER TABLE live_authoring_text_jobs ADD COLUMN generation_policy_hash text CHECK(generation_policy_hash IS NULL OR generation_policy_hash ~ '^[a-f0-9]{64}$');

ALTER TABLE npc_ai_jobs ADD COLUMN request_snapshot jsonb;
ALTER TABLE npc_ai_quotes ADD COLUMN request_snapshot jsonb;

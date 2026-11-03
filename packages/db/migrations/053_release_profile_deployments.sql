-- Ordered pre-deploy candidates and successful runtime activations are separate immutable facts.
CREATE TABLE generation_release_deployments (
 epoch bigserial PRIMARY KEY,
 deployment_id text NOT NULL UNIQUE,
 config_fingerprint text NOT NULL CHECK(config_fingerprint ~ '^[a-f0-9]{64}$'),
 profile_snapshot jsonb NOT NULL CHECK(jsonb_typeof(profile_snapshot)='object'),
 registered_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER generation_release_deployment_immutable BEFORE UPDATE OR DELETE ON generation_release_deployments
 FOR EACH ROW EXECUTE FUNCTION generation_policy_revision_immutable();
CREATE TABLE generation_release_activations (
 epoch bigint PRIMARY KEY REFERENCES generation_release_deployments(epoch),
 activated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER generation_release_activation_immutable BEFORE UPDATE OR DELETE ON generation_release_activations
 FOR EACH ROW EXECUTE FUNCTION generation_policy_revision_immutable();
ALTER TABLE live_test_sessions ADD COLUMN release_profile_epoch bigint NOT NULL DEFAULT 0 CHECK(release_profile_epoch>=0);
ALTER TABLE generation_policy_revisions ADD COLUMN release_profile_epoch bigint CHECK(release_profile_epoch>0);

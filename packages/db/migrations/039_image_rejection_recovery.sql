-- External billing evidence is owner-attested, not inferred from an HTTP status.
CREATE TABLE image_generation_recoveries (
 id uuid PRIMARY KEY,
 authorization_id uuid NOT NULL REFERENCES live_test_sessions(id),
 scope_id text NOT NULL REFERENCES generation_budget_scopes(id),
 job_id uuid NOT NULL UNIQUE REFERENCES image_generation_jobs(id),
 operation_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 actual_micros bigint NOT NULL CHECK(actual_micros>=0),
 evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object'),
 original_job jsonb NOT NULL CHECK(jsonb_typeof(original_job)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(authorization_id,operation_id)
);
CREATE FUNCTION image_generation_recovery_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Immutable image recovery receipt'; END $$;
CREATE TRIGGER image_generation_recovery_guard BEFORE UPDATE OR DELETE ON image_generation_recoveries
 FOR EACH ROW EXECUTE FUNCTION image_generation_recovery_immutable();

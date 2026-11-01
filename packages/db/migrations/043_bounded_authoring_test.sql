-- A single explicit, isolated authoring allowance. No historical grant or liability is rewritten.
CREATE TABLE bounded_authoring_tests (
 authorization_id uuid PRIMARY KEY REFERENCES live_test_sessions(id),
 owner_id uuid NOT NULL REFERENCES users(id),
 adventure_id uuid NOT NULL UNIQUE REFERENCES adventures(id),
 legacy_authorization_id uuid NOT NULL UNIQUE REFERENCES live_test_sessions(id),
 retained_reservation_id uuid NOT NULL UNIQUE REFERENCES generation_budget_reservations(id),
 scope_id text NOT NULL UNIQUE REFERENCES generation_budget_scopes(id),
 operation_id uuid NOT NULL, request_hash text NOT NULL,
 config_hash text NOT NULL, policy_hash text NOT NULL,
 profile_snapshot jsonb NOT NULL, baseline_spent_micros bigint NOT NULL CHECK(baseline_spent_micros>=0),
 retained_micros bigint NOT NULL CHECK(retained_micros=66900),
 cap_micros bigint NOT NULL CHECK(cap_micros=500000),
 aggregate_cap_micros bigint NOT NULL CHECK(aggregate_cap_micros=baseline_spent_micros+retained_micros+cap_micros),
 activated_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
 UNIQUE(owner_id,operation_id), CHECK(expires_at>activated_at AND expires_at<=activated_at+interval '2 hours')
);
CREATE FUNCTION bounded_authoring_test_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Bounded test receipt is immutable'; END $$;
CREATE TRIGGER bounded_authoring_test_receipt BEFORE UPDATE OR DELETE ON bounded_authoring_tests
 FOR EACH ROW EXECUTE FUNCTION bounded_authoring_test_immutable();

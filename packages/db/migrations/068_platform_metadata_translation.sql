-- Platform-funded, released story metadata only. No player wallet or grant is created.
ALTER TABLE generation_budget_scopes DROP CONSTRAINT generation_scope_allowance_mode;
ALTER TABLE generation_budget_scopes ADD CONSTRAINT generation_scope_allowance_mode CHECK (
 (NOT unlimited_allowance AND total_cap_micros IS NOT NULL AND text_cap_micros IS NOT NULL AND image_cap_micros IS NOT NULL)
 OR (unlimited_allowance AND (id ~ '^release:[a-f0-9-]{36}$' OR id='platform:story-metadata')
   AND total_cap_micros IS NULL AND text_cap_micros IS NULL AND image_cap_micros IS NULL)
);
CREATE TABLE platform_metadata_translation_jobs (
 id uuid PRIMARY KEY,
 adventure_id uuid REFERENCES adventures(id) ON DELETE SET NULL,
 requester_id uuid REFERENCES users(id) ON DELETE SET NULL,
 visibility text NOT NULL CHECK(visibility IN ('public','private')),
 locale text NOT NULL CHECK(locale IN ('ru','en','uk')),
 cache_keys text[] NOT NULL CHECK(cardinality(cache_keys) BETWEEN 1 AND 2),
 context jsonb,
 provider_version text NOT NULL,
 config_fingerprint text NOT NULL,
 request_snapshot jsonb,
 reservation_id uuid NOT NULL UNIQUE REFERENCES generation_budget_reservations(id),
 status text NOT NULL CHECK(status IN ('queued','dispatched','result_received','ready','failed','unknown','cancelled')),
 result jsonb,
 provider_usage jsonb,
 provider_request_id text,
 error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),
 deadline_at timestamptz,
 completed_at timestamptz
);
CREATE INDEX platform_metadata_translation_pending ON platform_metadata_translation_jobs(status,created_at);
CREATE INDEX platform_metadata_translation_source ON platform_metadata_translation_jobs(adventure_id);
CREATE TRIGGER platform_metadata_usage_immutable BEFORE UPDATE OF provider_usage ON platform_metadata_translation_jobs
 FOR EACH ROW EXECUTE FUNCTION preserve_generation_provider_usage();
-- Shared reservations retain financial liability after metadata erasure. Neither
-- request text nor a completed private translation is exposed through a new endpoint.

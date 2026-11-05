-- One explicitly accepted future-raster vision tranche per travel preparation.
ALTER TABLE visual_authoring_projects DROP CONSTRAINT visual_authoring_projects_project_purpose_check;
ALTER TABLE visual_authoring_projects ADD CONSTRAINT visual_authoring_projects_project_purpose_check CHECK(project_purpose IN ('authoring','game-start','travel-map'));
CREATE TABLE game_travel_map_groundings (
 preparation_id uuid PRIMARY KEY REFERENCES game_location_travel_preparations(id) ON DELETE CASCADE,
 project_id uuid NOT NULL UNIQUE REFERENCES visual_authoring_projects(id),
 envelope jsonb NOT NULL, quote jsonb NOT NULL,
 spark_quote_id uuid REFERENCES spark_quotes(id),
 quote_operation_id uuid NOT NULL UNIQUE, job_operation_id uuid NOT NULL UNIQUE,
 arrivals jsonb NOT NULL CHECK(jsonb_typeof(arrivals)='array'),
 context jsonb, context_hash text,
 image_revision_id uuid, image_sha256 text,
 count_id uuid UNIQUE REFERENCES runtime_map_token_counts(id),
 native_quote_id uuid UNIQUE REFERENCES live_authoring_text_quotes(id),
 job_id uuid UNIQUE REFERENCES live_authoring_text_jobs(id),
 status text NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','bound','queued','ready','failed','unknown')),
 result jsonb, error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION preserve_travel_grounding_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status <> 'prepared' AND (NEW.envelope IS DISTINCT FROM OLD.envelope OR NEW.quote IS DISTINCT FROM OLD.quote OR NEW.arrivals IS DISTINCT FROM OLD.arrivals OR NEW.spark_quote_id IS DISTINCT FROM OLD.spark_quote_id) THEN
   RAISE EXCEPTION 'TRAVEL_GROUNDING_CONSENT_IMMUTABLE';
 END IF;
 IF NEW.project_id <> OLD.project_id OR NEW.quote_operation_id <> OLD.quote_operation_id OR NEW.job_operation_id <> OLD.job_operation_id THEN
   RAISE EXCEPTION 'TRAVEL_GROUNDING_IDENTITY_IMMUTABLE';
 END IF;
 IF OLD.context IS NOT NULL AND (NEW.context IS DISTINCT FROM OLD.context OR NEW.context_hash IS DISTINCT FROM OLD.context_hash OR NEW.image_revision_id IS DISTINCT FROM OLD.image_revision_id OR NEW.image_sha256 IS DISTINCT FROM OLD.image_sha256) THEN
   RAISE EXCEPTION 'TRAVEL_GROUNDING_BODY_IMMUTABLE';
 END IF;
 IF (OLD.count_id IS NOT NULL AND NEW.count_id IS DISTINCT FROM OLD.count_id) OR (OLD.native_quote_id IS NOT NULL AND NEW.native_quote_id IS DISTINCT FROM OLD.native_quote_id) OR (OLD.job_id IS NOT NULL AND NEW.job_id IS DISTINCT FROM OLD.job_id) OR (OLD.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result) THEN
   RAISE EXCEPTION 'TRAVEL_GROUNDING_RESULT_IMMUTABLE';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER travel_grounding_binding_immutable BEFORE UPDATE ON game_travel_map_groundings FOR EACH ROW EXECUTE FUNCTION preserve_travel_grounding_binding();

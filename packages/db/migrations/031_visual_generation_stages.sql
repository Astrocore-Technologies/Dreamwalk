-- Explicit manual authoring stages reuse the durable image job/budget/admission boundary.
ALTER TABLE visual_authoring_projects ADD COLUMN generation_mode text NOT NULL DEFAULT 'fixture'
  CHECK(generation_mode IN ('fixture','external'));
ALTER TABLE visual_authoring_projects ADD COLUMN public_grounding jsonb NOT NULL DEFAULT '{}';
ALTER TABLE image_generation_quotes ALTER COLUMN adventure_id DROP NOT NULL;
ALTER TABLE image_generation_jobs ALTER COLUMN adventure_id DROP NOT NULL;
CREATE TABLE visual_authoring_stage_items (
  project_id uuid NOT NULL REFERENCES visual_authoring_projects(id),
  role text NOT NULL,
  stage text NOT NULL CHECK(stage IN ('concept','parts')),
  expected_project_revision integer NOT NULL CHECK(expected_project_revision>0),
  request jsonb NOT NULL,
  quote_operation_id uuid,
  quote_id uuid REFERENCES image_generation_quotes(id),
  quote_result jsonb,
  dispatch_operation_id uuid,
  job_id uuid UNIQUE REFERENCES image_generation_jobs(id),
  reused_revision_id uuid REFERENCES art_asset_revisions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,role),
  CHECK (NOT (job_id IS NOT NULL AND reused_revision_id IS NOT NULL))
);
CREATE INDEX visual_authoring_stage_jobs ON visual_authoring_stage_items(job_id) WHERE job_id IS NOT NULL;

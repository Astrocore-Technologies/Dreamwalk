ALTER TABLE visual_authoring_projects ADD COLUMN plan_origin text NOT NULL DEFAULT 'fixture'
  CHECK(plan_origin IN ('fixture','manual','ai-pending','ai-generated-plan'));
ALTER TABLE visual_authoring_projects ADD COLUMN plan_authority jsonb NOT NULL DEFAULT '{}';
-- Existing external workshop projects explicitly retain the original editable template workflow.
UPDATE visual_authoring_projects SET plan_origin='manual' WHERE kind='location' AND generation_mode='external';
CREATE TABLE live_authoring_text_quotes(
 id uuid PRIMARY KEY,actor_id uuid NOT NULL REFERENCES users(id),session_id uuid NOT NULL REFERENCES live_test_sessions(id),
 project_id uuid REFERENCES visual_authoring_projects(id) ON DELETE SET NULL,operation_id uuid NOT NULL,
 request_hash text NOT NULL,project_revision integer NOT NULL CHECK(project_revision>0),source_hash text NOT NULL,readset_hash text NOT NULL,context_hash text NOT NULL,
 context jsonb NOT NULL,provider_version text NOT NULL,upper_micros bigint NOT NULL DEFAULT 264036 CHECK(upper_micros=264036),
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(actor_id,operation_id)
);
CREATE TABLE live_authoring_text_jobs(
 id uuid PRIMARY KEY,actor_id uuid NOT NULL REFERENCES users(id),session_id uuid NOT NULL REFERENCES live_test_sessions(id),
 project_id uuid REFERENCES visual_authoring_projects(id) ON DELETE SET NULL,operation_id uuid NOT NULL,
 quote_id uuid NOT NULL UNIQUE REFERENCES live_authoring_text_quotes(id),request_hash text NOT NULL,
 project_revision integer NOT NULL CHECK(project_revision>0),source_hash text NOT NULL,readset_hash text NOT NULL,context_hash text NOT NULL,context jsonb NOT NULL,
 provider_version text NOT NULL,reservation_id uuid NOT NULL REFERENCES generation_budget_reservations(id),
 status text NOT NULL CHECK(status IN ('queued','dispatched','unknown','generated','committed','cancelled','stale','failed')),
 proposal jsonb,result jsonb,cancel_requested boolean NOT NULL DEFAULT false,
 dispatched_at timestamptz,deadline_at timestamptz,completed_at timestamptz,provider_request_id text,actual_micros bigint CHECK(actual_micros>=0),error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(actor_id,operation_id)
);
CREATE INDEX authoring_text_jobs_project ON live_authoring_text_jobs(project_id,created_at);
CREATE TABLE visual_spatial_proposals(
 id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES visual_authoring_projects(id),
 job_id uuid NOT NULL UNIQUE REFERENCES live_authoring_text_jobs(id),owner_id uuid NOT NULL REFERENCES users(id),
 project_revision integer NOT NULL CHECK(project_revision>0),source_hash text NOT NULL,readset_hash text NOT NULL,
 layout jsonb NOT NULL,plan jsonb NOT NULL,checksum text NOT NULL,
 status text NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','applied','cancelled')),
 created_at timestamptz NOT NULL DEFAULT now()
);

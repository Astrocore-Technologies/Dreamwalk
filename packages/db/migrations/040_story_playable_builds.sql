-- Private author-reviewed AI plans; no campaign state or financial ledger is rewritten.
CREATE TABLE story_playable_builds (
 project_id uuid PRIMARY KEY REFERENCES visual_authoring_projects(id) ON DELETE CASCADE,
 owner_id uuid NOT NULL REFERENCES users(id), adventure_id uuid NOT NULL REFERENCES adventures(id) ON DELETE CASCADE,
 source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'), source_snapshot jsonb NOT NULL,
 status text NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','proposed','applied','cancelled')),
 proposal jsonb, draft jsonb, job_id uuid REFERENCES live_authoring_text_jobs(id),
 created_at timestamptz NOT NULL DEFAULT now(), applied_at timestamptz
);
CREATE INDEX story_build_owner ON story_playable_builds(owner_id,adventure_id,created_at DESC);

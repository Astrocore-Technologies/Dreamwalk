-- Bounded mock decisions only. No provider credentials, paid usage or financial capture.
CREATE TABLE game_npc_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 campaign_id uuid NOT NULL REFERENCES game_campaigns(id),
 npc_id text NOT NULL,
 requester_actor_id text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','accepted','stale','cancelled')),
 proposal jsonb NOT NULL,
 due_at timestamptz NOT NULL,
 deadline_at timestamptz NOT NULL,
 result_code text,
 created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz
);
CREATE UNIQUE INDEX one_pending_mock_npc_job ON game_npc_jobs(campaign_id,npc_id) WHERE status='queued';
CREATE INDEX pending_mock_npc_job_due ON game_npc_jobs(campaign_id,due_at) WHERE status='queued';

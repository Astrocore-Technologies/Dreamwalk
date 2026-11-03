-- Exact unpaid world requests approved together; financial holds stay in native AI/Sparks tables.
CREATE TABLE game_world_generation_batches (
 id uuid PRIMARY KEY,
 campaign_id uuid NOT NULL REFERENCES game_campaigns(id) ON DELETE CASCADE,
 owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 operation_id uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('quoted','accepted','stale')) DEFAULT 'quoted',
 state_hash text NOT NULL,
 request_hash text NOT NULL,
 turn_fence jsonb NOT NULL,
 entries jsonb NOT NULL CHECK(jsonb_typeof(entries)='array'),
 quote jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 accepted_at timestamptz,
 UNIQUE(campaign_id,owner_id,operation_id)
);
CREATE INDEX game_world_generation_batches_pending ON game_world_generation_batches(campaign_id,state);

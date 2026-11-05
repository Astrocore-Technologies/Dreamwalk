-- One authenticated owner End turn authorizes only its exact ordinary round.
-- Native immutable quotes, funding checks and job idempotency remain authoritative.
CREATE TABLE game_ordinary_round_consents (
 campaign_id uuid NOT NULL REFERENCES game_campaigns(id) ON DELETE CASCADE,
 round_id text NOT NULL,
 owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 operation_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','accepted','blocked')),
 result_code text,
 batch_id uuid REFERENCES game_world_generation_batches(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(campaign_id,round_id),
 UNIQUE(campaign_id,owner_id,operation_id)
);

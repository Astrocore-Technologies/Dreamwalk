-- Durable once-per-round roster. No private memories or provider output here.
CREATE TABLE game_world_round_rosters (
 campaign_id uuid NOT NULL REFERENCES game_campaigns(id) ON DELETE CASCADE,
 round_id text NOT NULL,
 turn_fence jsonb NOT NULL CHECK(jsonb_typeof(turn_fence)='object'),
 roster jsonb NOT NULL CHECK(jsonb_typeof(roster)='array'),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(campaign_id,round_id)
);

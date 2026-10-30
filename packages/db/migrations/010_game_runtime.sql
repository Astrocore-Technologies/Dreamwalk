-- G0–G3 isolated, pinned mock adventure campaigns. No billing or provider calls.
CREATE TABLE game_campaigns (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_id uuid NOT NULL REFERENCES users(id),
 playable_version text NOT NULL,
 ruleset_version integer NOT NULL DEFAULT 1,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
 state jsonb NOT NULL,
 revision bigint NOT NULL DEFAULT 0,
 event_seq bigint NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE game_members (
 campaign_id uuid NOT NULL REFERENCES game_campaigns(id),
 user_id uuid NOT NULL REFERENCES users(id),
 actor_id text NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','accepted','revoked')),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(campaign_id,user_id), UNIQUE(campaign_id,actor_id)
);
CREATE TABLE game_events (
 campaign_id uuid NOT NULL REFERENCES game_campaigns(id),
 sequence bigint NOT NULL,
 kind text NOT NULL,
 payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(campaign_id,sequence)
);
CREATE TABLE game_operations (
 campaign_id uuid NOT NULL REFERENCES game_campaigns(id),
 actor_id text NOT NULL,
 operation_id uuid NOT NULL,
 request_hash text NOT NULL,
 result jsonb NOT NULL,
 PRIMARY KEY(campaign_id,actor_id,operation_id)
);
CREATE TABLE game_snapshots (
 campaign_id uuid PRIMARY KEY REFERENCES game_campaigns(id),
 sequence bigint NOT NULL,
 schema_version integer NOT NULL DEFAULT 1,
 checksum text NOT NULL,
 state jsonb NOT NULL
);
CREATE TABLE game_outbox (
 campaign_id uuid NOT NULL,
 sequence bigint NOT NULL,
 delivered_at timestamptz,
 PRIMARY KEY(campaign_id,sequence),
 FOREIGN KEY(campaign_id,sequence) REFERENCES game_events(campaign_id,sequence)
);
CREATE INDEX game_members_user_idx ON game_members(user_id,status);

-- Private, typed presentation corrections. The campaign checkpoint is authoritative;
-- this receipt records idempotency and account-owned history, never world commands.
CREATE TABLE game_narrative_preference_operations (
 campaign_id uuid NOT NULL REFERENCES game_campaigns(id) ON DELETE CASCADE,
 requester_user_id uuid NOT NULL REFERENCES users(id),
 operation_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(campaign_id,requester_user_id,operation_id)
);
CREATE INDEX game_narrative_preference_owner ON game_narrative_preference_operations(requester_user_id,created_at);

CREATE TABLE game_player_intent_proposals (
 id uuid PRIMARY KEY,
 campaign_id uuid NOT NULL REFERENCES game_campaigns(id) ON DELETE CASCADE,
 actor_id text NOT NULL,
 requester_user_id uuid NOT NULL REFERENCES users(id),
 operation_id uuid NOT NULL,
 request_hash text NOT NULL,
 text text NOT NULL CHECK(char_length(text) BETWEEN 1 AND 1000),
 decision_request_id uuid NOT NULL REFERENCES game_npc_decision_requests(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','proposed','clarification','confirmed','cancelled')),
 proposal jsonb,
 result_code text,
 valid_until_tick bigint NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(campaign_id,requester_user_id,operation_id)
);
CREATE INDEX game_player_intent_own ON game_player_intent_proposals(campaign_id,requester_user_id,created_at DESC);

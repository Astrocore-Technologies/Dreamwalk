-- One finite owner-bound grant; no credentials, prompts or source photos are stored here.
CREATE TABLE live_test_sessions (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id), scope_id text NOT NULL UNIQUE REFERENCES generation_budget_scopes(id),
 expires_at timestamptz NOT NULL, cap_micros bigint NOT NULL CHECK(cap_micros=1000000),
 state text NOT NULL CHECK(state IN ('active','stopped')), stop_code text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE live_test_text_permits (
 id uuid PRIMARY KEY, session_id uuid NOT NULL REFERENCES live_test_sessions(id), campaign_id uuid NOT NULL REFERENCES game_campaigns(id),
 request_id uuid NOT NULL UNIQUE REFERENCES game_npc_decision_requests(id), operation_id uuid NOT NULL,
 context_hash text NOT NULL, round_id text NOT NULL, phase_epoch bigint NOT NULL,
 reservation_id uuid NOT NULL UNIQUE REFERENCES generation_budget_reservations(id),
 state text NOT NULL CHECK(state IN ('authorized','dispatched','settled','unknown','cancelled')),
 dispatched_at timestamptz, completed_at timestamptz, result_code text, provider_request_id text,
 UNIQUE(session_id,operation_id)
);

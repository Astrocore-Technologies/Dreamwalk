-- Explicit manual token counting is separate from generation and preserves the shared financial scope.
CREATE TABLE generation_text_counts (
 id uuid PRIMARY KEY,authorization_id uuid NOT NULL REFERENCES live_test_sessions(id),
 scope_id text NOT NULL REFERENCES generation_budget_scopes(id),actor_id uuid NOT NULL REFERENCES users(id),
 campaign_id uuid REFERENCES game_campaigns(id) ON DELETE SET NULL,
 request_id uuid REFERENCES game_npc_decision_requests(id) ON DELETE SET NULL,
 operation_id uuid NOT NULL,request_hash text,source_hash text,body_sha256 text,
 model text NOT NULL,provider_version text NOT NULL,policy_revision integer NOT NULL,policy_hash text NOT NULL,
 turn_fence jsonb NOT NULL,pricing_snapshot jsonb NOT NULL,reservation_id uuid NOT NULL REFERENCES generation_budget_reservations(id),
 status text NOT NULL CHECK(status IN ('dispatched','succeeded','over_context','unknown','stale','erased')),
 input_tokens bigint CHECK(input_tokens>=0),actual_micros bigint CHECK(actual_micros>=0),result_code text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),deadline_at timestamptz NOT NULL,
 completed_at timestamptz,UNIQUE(authorization_id,operation_id)
);
CREATE INDEX generation_text_counts_request ON generation_text_counts(request_id,created_at);

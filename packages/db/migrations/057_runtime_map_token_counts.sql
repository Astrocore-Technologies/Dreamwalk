-- Operational exact counts requested by a gameplay quote, not generation or a
-- player charge. Keep unknown provider fees NULL, never invent a zero invoice.
-- No prompt, image, location labels or provider credential is persisted here.
CREATE TABLE runtime_map_token_counts (
  id uuid PRIMARY KEY,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  campaign_id uuid REFERENCES game_campaigns(id) ON DELETE SET NULL,
  body_sha256 text CHECK (body_sha256 ~ '^[a-f0-9]{64}$'),
  model text NOT NULL,
  provider_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('dispatched','succeeded','unknown','erased')),
  input_tokens bigint CHECK (input_tokens >= 0),
  provider_fee_micros bigint CHECK (provider_fee_micros >= 0),
  cost_basis text NOT NULL DEFAULT 'unverified_operational' CHECK (cost_basis = 'unverified_operational'),
  result_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz
);
CREATE INDEX runtime_map_token_counts_actor_time ON runtime_map_token_counts(actor_id,created_at);
CREATE UNIQUE INDEX runtime_map_token_counts_unresolved
  ON runtime_map_token_counts(actor_id,campaign_id,provider_version,body_sha256)
  WHERE status IN ('dispatched','unknown');
CREATE INDEX runtime_map_token_counts_body
  ON runtime_map_token_counts(actor_id,campaign_id,provider_version,body_sha256,created_at);

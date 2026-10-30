ALTER TABLE users ADD COLUMN email_verified boolean NOT NULL DEFAULT false;
CREATE TABLE auth_email_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('reset','verify')),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_email_tokens_user ON auth_email_tokens(user_id,purpose);
CREATE TABLE auth_email_cooldowns (
  address_hash text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('reset','verify')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(address_hash,purpose)
);
CREATE INDEX auth_email_cooldowns_age ON auth_email_cooldowns(requested_at);
CREATE INDEX auth_email_tokens_expiry ON auth_email_tokens(expires_at);

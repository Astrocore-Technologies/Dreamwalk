-- Existing users are explicitly grandfathered, NOT falsely marked verified.
-- Only new registrations after operational activation require email confirmation.
ALTER TABLE users ADD COLUMN email_verification_required boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN starter_sparks_eligible boolean NOT NULL DEFAULT false;
CREATE TABLE auth_identities (
  provider text NOT NULL CHECK (provider='google'),
  subject text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider,subject),
  UNIQUE(user_id,provider)
);
CREATE TABLE auth_oauth_attempts (
  state_hash text PRIMARY KEY,
  browser_hash text NOT NULL,
  nonce_hash text NOT NULL,
  code_verifier text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_oauth_attempts_expiry ON auth_oauth_attempts(expires_at);

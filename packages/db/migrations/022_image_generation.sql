-- Image jobs are independent from NPC decisions. External dispatch remains disabled by application policy.
CREATE TABLE image_generation_quotes (
 id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES users(id), adventure_id uuid NOT NULL REFERENCES adventures(id),
 request_hash text NOT NULL, input jsonb NOT NULL, reference_hashes jsonb NOT NULL, mode text NOT NULL CHECK(mode IN ('mock','external')),
 policy_version text NOT NULL, upper_micros bigint CHECK(upper_micros>=0), expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX image_quotes_actor ON image_generation_quotes(actor_id,created_at);
CREATE TABLE generation_budget_scopes (
 id text PRIMARY KEY, approved boolean NOT NULL DEFAULT false,
 total_cap_micros bigint NOT NULL CHECK(total_cap_micros>=0), image_cap_micros bigint NOT NULL CHECK(image_cap_micros>=0), text_cap_micros bigint NOT NULL CHECK(text_cap_micros>=0),
 blocked boolean NOT NULL DEFAULT false
);
CREATE TABLE generation_budget_reservations (
 id uuid PRIMARY KEY, scope_id text NOT NULL REFERENCES generation_budget_scopes(id), actor_id uuid REFERENCES users(id),
 kind text NOT NULL CHECK(kind IN ('text','image')), operation_key text NOT NULL,
 upper_micros bigint NOT NULL CHECK(upper_micros>=0), actual_micros bigint CHECK(actual_micros>=0),
 status text NOT NULL CHECK(status IN ('held','settled','released')), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(scope_id,operation_key)
);
CREATE TABLE image_generation_jobs (
 id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES users(id), adventure_id uuid NOT NULL REFERENCES adventures(id),
 operation_id uuid NOT NULL, quote_id uuid NOT NULL UNIQUE REFERENCES image_generation_quotes(id), request_hash text NOT NULL,
 input jsonb NOT NULL, reference_hashes jsonb NOT NULL, mode text NOT NULL CHECK(mode IN ('mock','external')), policy_version text NOT NULL,
 status text NOT NULL CHECK(status IN ('queued','dispatched','unknown','generated','admitted','rejected','cancelled','expired')),
 reservation_id uuid REFERENCES generation_budget_reservations(id), upper_micros bigint NOT NULL CHECK(upper_micros>=0), actual_micros bigint CHECK(actual_micros>=0),
 quota_reserved_bytes integer NOT NULL DEFAULT 5242880 CHECK(quota_reserved_bytes>=0), cancel_requested boolean NOT NULL DEFAULT false,
 dispatched_at timestamptz, dispatch_deadline timestamptz, expires_at timestamptz NOT NULL,
 provider_request_id text, quarantine_filename text, quarantine_sha256 text, quarantine_mime text,
 upload_id uuid NOT NULL UNIQUE, family_id uuid NOT NULL UNIQUE, revision_id uuid NOT NULL UNIQUE, admitted_revision_id uuid REFERENCES art_asset_revisions(id),
 error_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(actor_id,operation_id)
);
CREATE INDEX image_jobs_pending ON image_generation_jobs(status,created_at);
CREATE INDEX image_jobs_actor ON image_generation_jobs(actor_id,created_at);
CREATE TABLE image_generation_attempts (
 job_id uuid PRIMARY KEY REFERENCES image_generation_jobs(id), dispatch_id uuid NOT NULL UNIQUE, dispatched_at timestamptz NOT NULL DEFAULT now(),
 provider text NOT NULL, request_hash text NOT NULL, result_received_at timestamptz, actual_micros bigint CHECK(actual_micros>=0), provider_request_id text
);
CREATE FUNCTION cancel_ineligible_image_jobs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='users' THEN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
  UPDATE image_generation_jobs SET cancel_requested=true,quota_reserved_bytes=0,input='{}',reference_hashes='{}',error_code='AUTHORIZATION_REVOKED',updated_at=now() WHERE actor_id=NEW.id AND status<>'admitted';
  UPDATE image_generation_quotes SET input='{}',reference_hashes='{}' WHERE actor_id=NEW.id;
  END IF;
 ELSIF TG_TABLE_NAME='adventures' THEN
  IF NEW.status='archived' OR NEW.owner_id<>OLD.owner_id THEN
  UPDATE image_generation_jobs SET cancel_requested=true,quota_reserved_bytes=0,error_code='AUTHORIZATION_REVOKED',updated_at=now() WHERE adventure_id=NEW.id AND status<>'admitted';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER image_user_erasure AFTER UPDATE OF deleted_at ON users FOR EACH ROW EXECUTE FUNCTION cancel_ineligible_image_jobs();
CREATE TRIGGER image_source_revoke AFTER UPDATE OF status,owner_id ON adventures FOR EACH ROW EXECUTE FUNCTION cancel_ineligible_image_jobs();
CREATE TABLE image_generation_cleanup (
 filename text PRIMARY KEY CHECK(filename ~ '^[a-f0-9-]{36}\.image-quarantine$'),
 job_id uuid NOT NULL REFERENCES image_generation_jobs(id),created_at timestamptz NOT NULL DEFAULT now()
);

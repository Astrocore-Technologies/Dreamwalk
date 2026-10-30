-- Free mock by default. These records are not purchase processing or permission to call a provider.
CREATE TABLE npc_ai_provider_budgets (
 provider_id text PRIMARY KEY, blocked boolean NOT NULL DEFAULT false,
 cap_micros bigint NOT NULL CHECK(cap_micros>=0),
 reserved_micros bigint NOT NULL DEFAULT 0 CHECK(reserved_micros>=0),
 spent_micros bigint NOT NULL DEFAULT 0 CHECK(spent_micros>=0),
 unknown_micros bigint NOT NULL DEFAULT 0 CHECK(unknown_micros>=0),
 overrun_micros bigint NOT NULL DEFAULT 0 CHECK(overrun_micros>=0),
 CHECK(reserved_micros+spent_micros+unknown_micros<=cap_micros)
);
CREATE TABLE npc_ai_quotes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 campaign_id uuid NOT NULL REFERENCES game_campaigns(id), npc_id text NOT NULL,
 user_id uuid NOT NULL REFERENCES users(id), context_hash text NOT NULL,
 purpose text NOT NULL CHECK(purpose IN ('plan','summary','speech')),
 provider_id text NOT NULL, policy_version text NOT NULL,
 credits integer NOT NULL CHECK(credits>=0), upper_micros bigint NOT NULL CHECK(upper_micros>=0),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE npc_ai_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 campaign_id uuid NOT NULL REFERENCES game_campaigns(id), npc_id text NOT NULL,
 operation_id uuid NOT NULL, request_hash text NOT NULL, request_meta jsonb NOT NULL DEFAULT '{}', quote_id uuid UNIQUE REFERENCES npc_ai_quotes(id),
 origin text NOT NULL CHECK(origin IN ('user','system')),
 requester_user_id uuid REFERENCES users(id), payer_user_id uuid REFERENCES users(id),
 purpose text NOT NULL CHECK(purpose IN ('plan','summary','speech')),
 context_hash text NOT NULL, context jsonb NOT NULL,
 proposal jsonb, provider_id text NOT NULL, provider_version text NOT NULL, policy_version text NOT NULL,
 status text NOT NULL CHECK(status IN ('queued','reserved','running','result_received','validated','committed','stale','cancelled','failed','reconciling')),
 cancel_requested boolean NOT NULL DEFAULT false, result_code text,
 credits integer NOT NULL DEFAULT 0 CHECK(credits>=0),
 reservation_status text NOT NULL DEFAULT 'none' CHECK(reservation_status IN ('none','held','captured','released')),
 reservation_expires_at timestamptz NOT NULL,
 provider_upper_micros bigint NOT NULL DEFAULT 0 CHECK(provider_upper_micros>=0),
 provider_actual_micros bigint CHECK(provider_actual_micros>=0),
 provider_budget_status text NOT NULL DEFAULT 'none' CHECK(provider_budget_status IN ('none','reserved','spent','unknown','released')),
 provider_request_id text, input_tokens integer, output_tokens integer,
 started_at timestamptz, deadline_at timestamptz, result_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 UNIQUE(campaign_id,operation_id),
 CHECK(origin<>'user' OR requester_user_id IS NOT NULL),
 CHECK(credits=0 OR payer_user_id IS NOT NULL)
);
CREATE UNIQUE INDEX one_live_npc_ai_job ON npc_ai_jobs(campaign_id,npc_id)
 WHERE status IN ('queued','reserved','running','result_received','validated','reconciling');
CREATE INDEX npc_ai_ready ON npc_ai_jobs(campaign_id,status,created_at);
CREATE INDEX npc_ai_held ON npc_ai_jobs(payer_user_id) WHERE reservation_status='held';
CREATE TABLE npc_ai_cache (
 cache_key text PRIMARY KEY, campaign_id uuid NOT NULL REFERENCES game_campaigns(id),
 npc_id text NOT NULL, context_hash text NOT NULL, purpose text NOT NULL,
 provider_id text NOT NULL, provider_version text NOT NULL, policy_version text NOT NULL,
 proposal jsonb NOT NULL, expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE npc_ai_reconciliation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid NOT NULL REFERENCES npc_ai_jobs(id),
 event_key text NOT NULL UNIQUE, result text NOT NULL, actual_micros bigint,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION cancel_npc_ai_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.visibility IS DISTINCT FROM OLD.visibility OR
 (NEW.status='archived' AND OLD.status IS DISTINCT FROM NEW.status) OR
 (OLD.published_snapshot IS NOT NULL AND NEW.published_snapshot IS NULL) THEN
 UPDATE npc_ai_jobs j SET cancel_requested=true,result_code='SOURCE_UNAVAILABLE'
 FROM game_campaigns c JOIN game_playable_versions v ON v.id=c.source_version_id
 WHERE j.campaign_id=c.id AND v.adventure_id=NEW.id AND j.status NOT IN ('committed','stale','cancelled','failed');
 DELETE FROM npc_ai_cache k USING game_campaigns c,game_playable_versions v
 WHERE k.campaign_id=c.id AND c.source_version_id=v.id AND v.adventure_id=NEW.id;
 END IF; RETURN NEW;
END; $$;
CREATE TRIGGER cancel_npc_ai_source AFTER UPDATE OF visibility,status,published_snapshot ON adventures FOR EACH ROW EXECUTE FUNCTION cancel_npc_ai_source();
CREATE FUNCTION cancel_npc_ai_invitation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status='accepted' AND NEW.status<>'accepted' THEN
 UPDATE npc_ai_jobs j SET cancel_requested=true,result_code='SOURCE_ACCESS_REVOKED'
 FROM game_campaigns c JOIN game_playable_versions v ON v.id=c.source_version_id
 WHERE j.campaign_id=c.id AND v.adventure_id=NEW.adventure_id

 AND j.status NOT IN ('committed','stale','cancelled','failed');
 DELETE FROM npc_ai_cache k USING game_campaigns c,game_playable_versions v
 WHERE k.campaign_id=c.id AND c.source_version_id=v.id AND v.adventure_id=NEW.adventure_id;
 END IF; RETURN NEW;
END; $$;
CREATE TRIGGER cancel_npc_ai_invitation AFTER UPDATE OF status ON adventure_invitations FOR EACH ROW EXECUTE FUNCTION cancel_npc_ai_invitation();
CREATE FUNCTION cancel_npc_ai_member() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status='accepted' AND NEW.status<>'accepted' THEN
 UPDATE npc_ai_jobs SET cancel_requested=true,result_code='MEMBERSHIP_REVOKED'
 WHERE campaign_id=NEW.campaign_id
 AND status NOT IN ('committed','stale','cancelled','failed');
 DELETE FROM npc_ai_cache WHERE campaign_id=NEW.campaign_id;
 END IF; RETURN NEW;
END; $$;
CREATE TRIGGER cancel_npc_ai_member AFTER UPDATE OF status ON game_members FOR EACH ROW EXECUTE FUNCTION cancel_npc_ai_member();
CREATE FUNCTION cancel_npc_ai_user() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
 UPDATE npc_ai_jobs SET cancel_requested=true,result_code='USER_DELETED'
 WHERE (requester_user_id=NEW.id OR payer_user_id=NEW.id OR campaign_id IN (SELECT id FROM game_campaigns WHERE owner_id=NEW.id) OR campaign_id IN (SELECT campaign_id FROM game_members WHERE user_id=NEW.id))
 AND status NOT IN ('committed','stale','cancelled','failed');
 END IF; RETURN NEW;
END; $$;
CREATE TRIGGER cancel_npc_ai_user AFTER UPDATE OF deleted_at ON users FOR EACH ROW EXECUTE FUNCTION cancel_npc_ai_user();

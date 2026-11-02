-- Explicit uncapped release allowances, never fabricated large caps or balance changes.
ALTER TABLE generation_budget_scopes ADD COLUMN unlimited_allowance boolean NOT NULL DEFAULT false;
ALTER TABLE generation_budget_scopes ALTER COLUMN total_cap_micros DROP NOT NULL;
ALTER TABLE generation_budget_scopes ALTER COLUMN text_cap_micros DROP NOT NULL;
ALTER TABLE generation_budget_scopes ALTER COLUMN image_cap_micros DROP NOT NULL;
ALTER TABLE generation_budget_scopes ADD CONSTRAINT generation_scope_allowance_mode CHECK (
 (NOT unlimited_allowance AND total_cap_micros IS NOT NULL AND text_cap_micros IS NOT NULL AND image_cap_micros IS NOT NULL)
 OR (unlimited_allowance AND id ~ '^release:[a-f0-9-]{36}$' AND total_cap_micros IS NULL AND text_cap_micros IS NULL AND image_cap_micros IS NULL)
);
ALTER TABLE live_test_sessions ADD COLUMN unlimited_allowance boolean NOT NULL DEFAULT false;
ALTER TABLE live_test_sessions ALTER COLUMN cap_micros DROP NOT NULL;
ALTER TABLE live_test_sessions DROP CONSTRAINT generation_authorization_mode;
ALTER TABLE live_test_sessions ADD CONSTRAINT generation_authorization_mode CHECK(
 (mode='manual' AND NOT unlimited_allowance AND cap_micros IS NOT NULL AND expires_at IS NOT NULL AND config_hash IS NULL AND owner_handle IS NULL AND cap_micros=1000000 AND text_cap_micros IS NULL AND image_cap_micros IS NULL)
 OR (mode='owner' AND NOT unlimited_allowance AND cap_micros IS NOT NULL AND expires_at IS NULL AND config_hash IS NOT NULL AND config_hash ~ '^[a-f0-9]{64}$' AND owner_handle IS NOT NULL AND text_cap_micros IS NOT NULL AND text_cap_micros>0 AND image_cap_micros IS NOT NULL AND image_cap_micros>0)
 OR (mode='release' AND expires_at IS NULL AND config_hash IS NOT NULL AND config_hash ~ '^[a-f0-9]{64}$' AND owner_handle IS NULL AND scope_id='release:'||owner_id::text AND (
  (NOT unlimited_allowance AND cap_micros IS NOT NULL AND text_cap_micros IS NOT NULL AND text_cap_micros>0 AND image_cap_micros IS NOT NULL AND image_cap_micros>0)
  OR (unlimited_allowance AND cap_micros IS NULL AND text_cap_micros IS NULL AND image_cap_micros IS NULL)
 ))
);
-- No historical session, reservation, receipt, wallet or ledger row is rewritten.

-- Native release NPC accounting keeps all counters while omitting an operator ceiling.
ALTER TABLE npc_ai_provider_budgets ADD COLUMN unlimited_allowance boolean NOT NULL DEFAULT false;
ALTER TABLE npc_ai_provider_budgets ALTER COLUMN cap_micros DROP NOT NULL;
ALTER TABLE npc_ai_provider_budgets ADD CONSTRAINT npc_provider_allowance_mode CHECK (
 (unlimited_allowance AND cap_micros IS NULL AND provider_id LIKE 'release:%')
 OR (NOT unlimited_allowance AND cap_micros IS NOT NULL)
);

-- Persist validated provider token/cost receipts only; no prompt or response content.
ALTER TABLE npc_ai_jobs ADD COLUMN provider_usage jsonb CHECK(provider_usage IS NULL OR jsonb_typeof(provider_usage)='object');
ALTER TABLE live_authoring_text_jobs ADD COLUMN provider_usage jsonb CHECK(provider_usage IS NULL OR jsonb_typeof(provider_usage)='object');
CREATE FUNCTION preserve_generation_provider_usage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.provider_usage IS NOT NULL AND NEW.provider_usage IS DISTINCT FROM OLD.provider_usage THEN
  RAISE EXCEPTION 'PROVIDER_USAGE_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER npc_provider_usage_immutable BEFORE UPDATE OF provider_usage ON npc_ai_jobs FOR EACH ROW EXECUTE FUNCTION preserve_generation_provider_usage();
CREATE TRIGGER authoring_provider_usage_immutable BEFORE UPDATE OF provider_usage ON live_authoring_text_jobs FOR EACH ROW EXECUTE FUNCTION preserve_generation_provider_usage();

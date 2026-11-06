-- The private API role already has table grants but is deliberately neither owner nor BYPASSRLS.
-- RLS stays enabled. Never grant these policies to PUBLIC, anon, authenticated or browser roles.
-- The API authorizes users/owners before accessing these tables; this role is backend-only.
-- Local owner-only installations need no role/policy and must not create a production credential.
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='dreamwalk_runtime') THEN
  CREATE POLICY dream_runtime_wallet_select ON dream_wallets FOR SELECT TO dreamwalk_runtime USING (true);
  CREATE POLICY dream_runtime_wallet_insert ON dream_wallets FOR INSERT TO dreamwalk_runtime WITH CHECK (true);
  CREATE POLICY dream_runtime_wallet_update ON dream_wallets FOR UPDATE TO dreamwalk_runtime USING (true) WITH CHECK (true);
  CREATE POLICY dream_runtime_quote_select ON dream_quotes FOR SELECT TO dreamwalk_runtime USING (true);
  CREATE POLICY dream_runtime_quote_insert ON dream_quotes FOR INSERT TO dreamwalk_runtime WITH CHECK (true);
  CREATE POLICY dream_runtime_hold_select ON dream_holds FOR SELECT TO dreamwalk_runtime USING (true);
  CREATE POLICY dream_runtime_hold_insert ON dream_holds FOR INSERT TO dreamwalk_runtime WITH CHECK (true);
  CREATE POLICY dream_runtime_hold_update ON dream_holds FOR UPDATE TO dreamwalk_runtime USING (true) WITH CHECK (true);
  CREATE POLICY dream_runtime_ledger_select ON dream_ledger FOR SELECT TO dreamwalk_runtime USING (true);
  CREATE POLICY dream_runtime_ledger_insert ON dream_ledger FOR INSERT TO dreamwalk_runtime WITH CHECK (true);
 END IF;
END $$;

-- Independent usage currency. No legacy wallet, demo balance, provider cap or live hold is changed.
-- No account is activated or funded by this migration.
CREATE TABLE spark_wallets (
 owner_id uuid PRIMARY KEY REFERENCES users(id),
 enabled boolean NOT NULL DEFAULT false,
 balance_subunits bigint NOT NULL DEFAULT 0 CHECK(balance_subunits>=0),
 held_subunits bigint NOT NULL DEFAULT 0 CHECK(held_subunits>=0 AND held_subunits<=balance_subunits),
 denomination text NOT NULL DEFAULT 'api-cent-1-spark-v1' CHECK(denomination='api-cent-1-spark-v1'),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE spark_quotes (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES spark_wallets(owner_id),
 operation_id uuid NOT NULL, request_hash text NOT NULL,
 source_kind text NOT NULL CHECK(source_kind IN ('npc','text','image')),
 source_id text NOT NULL, price_snapshot jsonb NOT NULL,
 reserve_subunits bigint NOT NULL CHECK(reserve_subunits>=0),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,operation_id), UNIQUE(id,owner_id)
);
CREATE TABLE spark_holds (
 id uuid PRIMARY KEY REFERENCES spark_quotes(id), owner_id uuid NOT NULL,
 source_kind text NOT NULL, source_id text NOT NULL,
 reserved_subunits bigint NOT NULL CHECK(reserved_subunits>=0),
 captured_subunits bigint CHECK(captured_subunits>=0 AND captured_subunits<=reserved_subunits),
 status text NOT NULL CHECK(status IN ('held','pending','settled','released')),
 settlement_fingerprint text, reason text,
 created_at timestamptz NOT NULL DEFAULT now(), settled_at timestamptz,
 FOREIGN KEY(id,owner_id) REFERENCES spark_quotes(id,owner_id),
 UNIQUE(owner_id,source_kind,source_id),
 CHECK((status IN ('held','pending') AND captured_subunits IS NULL AND settled_at IS NULL)
    OR (status IN ('settled','released') AND captured_subunits IS NOT NULL AND settled_at IS NOT NULL))
);
CREATE TABLE spark_ledger (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 owner_id uuid NOT NULL REFERENCES spark_wallets(owner_id),
 hold_id uuid NOT NULL REFERENCES spark_holds(id),
 event_key text NOT NULL UNIQUE,
 kind text NOT NULL CHECK(kind IN ('reserve','pending','capture','release')),
 amount_subunits bigint NOT NULL CHECK(amount_subunits>=0),
 evidence jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION spark_immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Sparks accounting records are immutable'; END $$;
CREATE TRIGGER spark_quote_immutable BEFORE UPDATE OR DELETE ON spark_quotes
 FOR EACH ROW EXECUTE FUNCTION spark_immutable_record();
CREATE TRIGGER spark_ledger_append_only BEFORE UPDATE OR DELETE ON spark_ledger
 FOR EACH ROW EXECUTE FUNCTION spark_immutable_record();
CREATE FUNCTION spark_hold_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
 OR NEW.source_kind IS DISTINCT FROM OLD.source_kind OR NEW.source_id IS DISTINCT FROM OLD.source_id
 OR NEW.reserved_subunits IS DISTINCT FROM OLD.reserved_subunits
 OR OLD.status IN ('settled','released') THEN
  RAISE EXCEPTION 'Sparks hold identity or final settlement is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER spark_hold_identity BEFORE UPDATE ON spark_holds FOR EACH ROW EXECUTE FUNCTION spark_hold_guard();
ALTER TABLE npc_ai_jobs ADD COLUMN cached_input_tokens integer
 CHECK(cached_input_tokens>=0 AND cached_input_tokens<=input_tokens);

-- Nullable bindings preserve every pre-existing provider quote/job and financial control.
ALTER TABLE generation_budget_reservations ADD COLUMN spark_quote_id uuid REFERENCES spark_quotes(id);
ALTER TABLE image_generation_quotes ADD COLUMN spark_quote_id uuid REFERENCES spark_quotes(id);
ALTER TABLE image_generation_jobs ADD COLUMN spark_quote_id uuid REFERENCES spark_quotes(id);
ALTER TABLE live_test_text_permits ADD COLUMN spark_quote_id uuid REFERENCES spark_quotes(id);
ALTER TABLE live_authoring_text_quotes ADD COLUMN spark_quote_id uuid REFERENCES spark_quotes(id);
ALTER TABLE live_authoring_text_jobs ADD COLUMN spark_quote_id uuid REFERENCES spark_quotes(id);
ALTER TABLE npc_ai_quotes ADD COLUMN spark_quote_id uuid REFERENCES spark_quotes(id);
ALTER TABLE npc_ai_jobs ADD COLUMN spark_hold_id uuid REFERENCES spark_holds(id);
ALTER TABLE live_authoring_text_jobs ADD COLUMN spark_cost_evidence text CHECK(spark_cost_evidence IN ('reported','configured_rates'));

ALTER TABLE generation_text_counts ADD COLUMN spark_quote_id uuid REFERENCES spark_quotes(id);

-- One admitted monetary reservation per hold, never a reusable authorization for another dispatch.
CREATE UNIQUE INDEX generation_reservation_spark_quote_once ON generation_budget_reservations(spark_quote_id) WHERE spark_quote_id IS NOT NULL;

ALTER TABLE image_generation_jobs ADD COLUMN spark_cost_verified boolean;

-- Independent usage currency. No legacy wallet, demo balance, provider cap or live hold is changed.
-- No account is activated or funded by this migration.
CREATE TABLE dream_wallets (
 owner_id uuid PRIMARY KEY REFERENCES users(id),
 enabled boolean NOT NULL DEFAULT false,
 balance_subunits bigint NOT NULL DEFAULT 0 CHECK(balance_subunits>=0),
 held_subunits bigint NOT NULL DEFAULT 0 CHECK(held_subunits>=0 AND held_subunits<=balance_subunits),
 denomination text NOT NULL DEFAULT 'dream-unit-v1' CHECK(denomination='dream-unit-v1'),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE dream_quotes (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES dream_wallets(owner_id),
 operation_id uuid NOT NULL, request_hash text NOT NULL,
 source_kind text NOT NULL CHECK(source_kind IN ('npc','text','image','translation')),
 source_id text NOT NULL, price_snapshot jsonb NOT NULL,
 reserve_subunits bigint NOT NULL CHECK(reserve_subunits>=0),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,operation_id), UNIQUE(id,owner_id)
);
CREATE TABLE dream_holds (
 id uuid PRIMARY KEY REFERENCES dream_quotes(id), owner_id uuid NOT NULL,
 source_kind text NOT NULL, source_id text NOT NULL,
 reserved_subunits bigint NOT NULL CHECK(reserved_subunits>=0),
 captured_subunits bigint CHECK(captured_subunits>=0 AND captured_subunits<=reserved_subunits),
 status text NOT NULL CHECK(status IN ('held','pending','settled','released')),
 settlement_fingerprint text, reason text,
 created_at timestamptz NOT NULL DEFAULT now(), settled_at timestamptz,
 FOREIGN KEY(id,owner_id) REFERENCES dream_quotes(id,owner_id),
 UNIQUE(owner_id,source_kind,source_id),
 CHECK((status IN ('held','pending') AND captured_subunits IS NULL AND settled_at IS NULL)
    OR (status IN ('settled','released') AND captured_subunits IS NOT NULL AND settled_at IS NOT NULL))
);
CREATE TABLE dream_ledger (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 owner_id uuid NOT NULL REFERENCES dream_wallets(owner_id),
 hold_id uuid REFERENCES dream_holds(id),
 event_key text NOT NULL UNIQUE,
 kind text NOT NULL CHECK(kind IN ('reserve','pending','capture','release','starter_grant')),
 amount_subunits bigint NOT NULL CHECK(amount_subunits>=0),
 evidence jsonb NOT NULL DEFAULT '{}',
 CHECK((kind='starter_grant' AND hold_id IS NULL AND amount_subunits=500000 AND event_key='dream-starter:v1:' || owner_id::text) OR (kind<>'starter_grant' AND hold_id IS NOT NULL)), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION dream_immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Dreams accounting records are immutable'; END $$;
CREATE TRIGGER dream_quote_immutable BEFORE UPDATE OR DELETE ON dream_quotes
 FOR EACH ROW EXECUTE FUNCTION dream_immutable_record();
CREATE TRIGGER dream_ledger_append_only BEFORE UPDATE OR DELETE ON dream_ledger
 FOR EACH ROW EXECUTE FUNCTION dream_immutable_record();
CREATE FUNCTION dream_hold_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
 OR NEW.source_kind IS DISTINCT FROM OLD.source_kind OR NEW.source_id IS DISTINCT FROM OLD.source_id
 OR NEW.reserved_subunits IS DISTINCT FROM OLD.reserved_subunits
 OR OLD.status IN ('settled','released') THEN
  RAISE EXCEPTION 'Dreams hold identity or final settlement is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER dream_hold_identity BEFORE UPDATE ON dream_holds FOR EACH ROW EXECUTE FUNCTION dream_hold_guard();

CREATE UNIQUE INDEX dream_starter_grant_once ON dream_ledger(owner_id) WHERE kind='starter_grant';
ALTER TABLE users ADD COLUMN starter_dreams_eligible boolean NOT NULL DEFAULT false;
-- Existing users receive no grant or activation. No Sparks data is changed.
ALTER TABLE dream_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE dream_quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE dream_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE dream_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON dream_wallets,dream_quotes,dream_holds,dream_ledger FROM PUBLIC;
-- Existing quotes/holds retain Sparks-only semantics. New hold allocation is immutable.
ALTER TABLE spark_holds ADD COLUMN dream_hold_id uuid UNIQUE REFERENCES dream_holds(id);
ALTER TABLE spark_holds ADD COLUMN sparks_reserved_subunits bigint CHECK(sparks_reserved_subunits>=0 AND sparks_reserved_subunits<=reserved_subunits);
CREATE FUNCTION spark_funding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.dream_hold_id IS DISTINCT FROM OLD.dream_hold_id OR NEW.sparks_reserved_subunits IS DISTINCT FROM OLD.sparks_reserved_subunits THEN
 RAISE EXCEPTION 'Currency allocation is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER spark_hold_funding_immutable BEFORE UPDATE ON spark_holds FOR EACH ROW EXECUTE FUNCTION spark_funding_guard();
ALTER TABLE dream_holds ADD CONSTRAINT dream_holds_owner_identity UNIQUE(id,owner_id);
ALTER TABLE spark_holds ADD CONSTRAINT spark_dream_hold_owner FOREIGN KEY(dream_hold_id,owner_id) REFERENCES dream_holds(id,owner_id);
ALTER TABLE spark_holds ADD CONSTRAINT spark_funding_shape CHECK (
 (dream_hold_id IS NULL AND (sparks_reserved_subunits IS NULL OR sparks_reserved_subunits=reserved_subunits))
 OR (dream_hold_id IS NOT NULL AND sparks_reserved_subunits IS NOT NULL AND sparks_reserved_subunits<reserved_subunits)
);

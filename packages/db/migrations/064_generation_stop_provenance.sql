-- Future-only provenance. Existing gates are deliberately NOT backfilled.
CREATE TABLE generation_stop_epochs (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 target_kind text NOT NULL CHECK(target_kind IN ('scope','authorization','provider')),
 target_id text NOT NULL,
 baseline_unknown boolean NOT NULL,
 opened_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE generation_stop_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 epoch_id bigint NOT NULL REFERENCES generation_stop_epochs(id),
 reason text NOT NULL,
 cause_code text NOT NULL,
 stop_class text NOT NULL CHECK(stop_class IN ('request','authorization')),
 source_kind text NOT NULL,
 source_id text,
 authorization_id uuid,
 scope_id text,
 policy_revision integer,
 policy_hash text,
 config_hash text,
 recoverable boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX generation_stop_events_epoch ON generation_stop_events(epoch_id,id);
CREATE TABLE generation_access_recoveries (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 scope_epoch_id bigint NOT NULL UNIQUE REFERENCES generation_stop_epochs(id),
 authorization_epoch_id bigint NOT NULL UNIQUE REFERENCES generation_stop_epochs(id),
 scope_id text NOT NULL,
 authorization_id uuid NOT NULL,
 evidence_hash text NOT NULL CHECK(evidence_hash ~ '^[a-f0-9]{64}$'),
 evidence jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION generation_stop_record_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Generation stop provenance is immutable'; END $$;
CREATE TRIGGER generation_stop_epochs_immutable BEFORE UPDATE OR DELETE ON generation_stop_epochs
 FOR EACH ROW EXECUTE FUNCTION generation_stop_record_immutable();
CREATE TRIGGER generation_stop_events_immutable BEFORE UPDATE OR DELETE ON generation_stop_events
 FOR EACH ROW EXECUTE FUNCTION generation_stop_record_immutable();
CREATE TRIGGER generation_access_recoveries_immutable BEFORE UPDATE OR DELETE ON generation_access_recoveries
 FOR EACH ROW EXECUTE FUNCTION generation_stop_record_immutable();
ALTER TABLE generation_budget_scopes ADD COLUMN stop_epoch_id bigint REFERENCES generation_stop_epochs(id);
ALTER TABLE live_test_sessions ADD COLUMN stop_epoch_id bigint REFERENCES generation_stop_epochs(id);
ALTER TABLE npc_ai_provider_budgets ADD COLUMN stop_epoch_id bigint REFERENCES generation_stop_epochs(id);
CREATE FUNCTION capture_generation_stop() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
 kind text; target text; stopped boolean; was_stopped boolean;
 context jsonb; a live_test_sessions%ROWTYPE; matches boolean := false;
BEGIN
 IF TG_TABLE_NAME='generation_budget_scopes' THEN
  kind := 'scope'; target := NEW.id; stopped := NEW.blocked;
  was_stopped := CASE WHEN TG_OP='INSERT' THEN true ELSE OLD.blocked END;
 ELSIF TG_TABLE_NAME='live_test_sessions' THEN
  kind := 'authorization'; target := NEW.id::text; stopped := NEW.state='stopped';
  was_stopped := CASE WHEN TG_OP='INSERT' THEN true ELSE OLD.state='stopped' END;
 ELSE
  kind := 'provider'; target := NEW.provider_id; stopped := NEW.blocked;
  was_stopped := CASE WHEN TG_OP='INSERT' THEN true ELSE OLD.blocked END;
 END IF;
 -- A legacy/explicit clear does not manufacture a clean epoch for existing blocks.
 IF NOT stopped THEN NEW.stop_epoch_id := NULL; RETURN NEW; END IF;
 IF TG_OP='INSERT' THEN NEW.stop_epoch_id := NULL;
 ELSE NEW.stop_epoch_id := OLD.stop_epoch_id; END IF;
 IF NEW.stop_epoch_id IS NULL THEN
  INSERT INTO generation_stop_epochs(target_kind,target_id,baseline_unknown)
   VALUES(kind,target,was_stopped) RETURNING id INTO NEW.stop_epoch_id;
 END IF;
 context := NULLIF(current_setting('dreamwalk.generation_stop_context',true),'')::jsonb;
 IF context IS NOT NULL AND context->>'authorizationId' IS NOT NULL THEN
  SELECT * INTO a FROM live_test_sessions WHERE id=(context->>'authorizationId')::uuid;
  matches := a.id IS NOT NULL AND
   ((kind='authorization' AND target=a.id::text) OR
    (kind='scope' AND target=a.scope_id) OR
    (kind='provider' AND target=context->>'providerId'));
 END IF;
 IF kind='provider' AND target=context->>'providerId' THEN matches := true; END IF;
 IF kind='scope' AND target=context->>'scopeId' THEN matches := true; END IF;
 INSERT INTO generation_stop_events(epoch_id,reason,cause_code,stop_class,source_kind,source_id,authorization_id,
   scope_id,policy_revision,policy_hash,config_hash,recoverable)
 VALUES(NEW.stop_epoch_id,
   CASE WHEN matches THEN COALESCE(context->>'reason','UNATTRIBUTED_STOP') ELSE 'UNATTRIBUTED_STOP' END,
   CASE WHEN matches THEN COALESCE(context->>'causeCode',context->>'reason','UNATTRIBUTED_STOP') ELSE 'UNATTRIBUTED_STOP' END,
   CASE WHEN matches AND COALESCE(context->>'stopClass'='request',false) THEN 'request' ELSE 'authorization' END,
   CASE WHEN matches THEN COALESCE(context->>'sourceKind','unattributed') ELSE 'unattributed' END,
   CASE WHEN matches THEN context->>'sourceId' END,
   CASE WHEN matches THEN a.id END, CASE WHEN matches THEN COALESCE(a.scope_id,context->>'scopeId') END,
   CASE WHEN matches THEN a.policy_revision END, CASE WHEN matches THEN a.policy_hash END,
   CASE WHEN matches THEN a.config_hash END,
   matches AND a.id IS NOT NULL AND COALESCE(context->>'recoverable'='true',false)
    AND COALESCE(context->>'stopClass'='request',false)
    AND context->>'reason' IN ('IMAGE_RESULT_UNKNOWN','PROVIDER_OUTCOME_UNKNOWN','TEXT_COUNT_OUTCOME_UNKNOWN','REQUEST_TIMEOUT','REQUEST_DEADLINE_EXCEEDED','JOB_CANCELLED_UNKNOWN')
    AND context->>'sourceKind' IN ('image','count','permit','authoring','npc')
    AND context->>'sourceId' IS NOT NULL);
 RETURN NEW;
END $$;
CREATE TRIGGER generation_scope_stop_capture BEFORE INSERT OR UPDATE OF blocked,stop_epoch_id ON generation_budget_scopes
 FOR EACH ROW EXECUTE FUNCTION capture_generation_stop();
CREATE TRIGGER generation_authorization_stop_capture BEFORE INSERT OR UPDATE OF state,stop_code,stop_epoch_id ON live_test_sessions
 FOR EACH ROW EXECUTE FUNCTION capture_generation_stop();
CREATE TRIGGER generation_provider_stop_capture BEFORE INSERT OR UPDATE OF blocked,stop_epoch_id ON npc_ai_provider_budgets
 FOR EACH ROW EXECUTE FUNCTION capture_generation_stop();

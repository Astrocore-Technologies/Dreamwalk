ALTER TABLE data_requests ADD COLUMN completed_at timestamptz;
ALTER TABLE data_requests ADD COLUMN expires_at timestamptz;
ALTER TABLE data_requests ADD COLUMN artifact jsonb;
ALTER TABLE data_requests ADD COLUMN processing_started_at timestamptz;
ALTER TABLE data_requests ADD COLUMN operator_reference text;
-- Erasure is an irreversible fixed projection, never permission to rewrite history.
CREATE OR REPLACE FUNCTION prevent_immutable_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE subject uuid;
BEGIN
 IF TG_OP='UPDATE' AND current_setting('dreamwalk.erasure',true)='confirmed' THEN
  IF TG_TABLE_NAME='adventure_versions' THEN
   SELECT a.owner_id INTO subject FROM adventures a JOIN users u ON u.id=a.owner_id WHERE a.id=OLD.adventure_id AND u.deleted_at IS NOT NULL;
   IF subject IS NOT NULL AND NEW.snapshot='{"erased":true}'::jsonb AND (to_jsonb(NEW)-'snapshot')=(to_jsonb(OLD)-'snapshot') THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='audit' THEN
   SELECT id INTO subject FROM users WHERE deleted_at IS NOT NULL AND (id=OLD.actor_id OR id::text=OLD.target_id OR EXISTS(SELECT 1 FROM adventures a WHERE a.owner_id=users.id AND a.id::text=OLD.target_id));
   IF subject IS NOT NULL AND NEW.details='{"erased":true}'::jsonb AND (to_jsonb(NEW)-'details')=(to_jsonb(OLD)-'details') THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='ledger' THEN
   SELECT id INTO subject FROM users WHERE id=OLD.user_id AND deleted_at IS NOT NULL;
   IF subject IS NOT NULL AND NEW.reason='Erased account' AND NEW.source_key='erased:'||OLD.id::text AND (to_jsonb(NEW)-'reason'-'source_key')=(to_jsonb(OLD)-'reason'-'source_key') THEN RETURN NEW; END IF;
  END IF;
 END IF;
 RAISE EXCEPTION 'Append-only table';
END; $$;

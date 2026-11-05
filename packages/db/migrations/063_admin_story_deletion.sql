-- Recoverable administrative removal. Immutable versions, player saves, shared
-- assets and accounting records are retained; this is not a physical data purge.
ALTER TABLE adventures ADD COLUMN deleted_at timestamptz;
ALTER TABLE adventures ADD COLUMN deleted_by uuid REFERENCES users(id);
ALTER TABLE adventures ADD COLUMN deletion_id uuid;
ALTER TABLE adventures ADD CONSTRAINT deleted_adventure_is_archived
  CHECK (deleted_at IS NULL OR (status='archived' AND deletion_id IS NOT NULL));
CREATE INDEX adventure_trash_idx ON adventures(deleted_at DESC) WHERE deleted_at IS NOT NULL;

-- Durable replay identity, including after multiple delete/restore cycles.
CREATE TABLE adventure_deletion_operations (
  actor_id uuid NOT NULL REFERENCES users(id),
  operation_id uuid NOT NULL,
  adventure_id uuid NOT NULL REFERENCES adventures(id),
  expected_revision text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_id,operation_id)
);
CREATE TRIGGER adventure_deletion_operation_immutable BEFORE UPDATE OR DELETE
  ON adventure_deletion_operations FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();

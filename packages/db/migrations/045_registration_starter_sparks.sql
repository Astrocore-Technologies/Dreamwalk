-- A registration-only gift; no existing wallet/user is funded or activated here.
ALTER TABLE spark_ledger ALTER COLUMN hold_id DROP NOT NULL;
ALTER TABLE spark_ledger DROP CONSTRAINT spark_ledger_kind_check;
ALTER TABLE spark_ledger ADD CONSTRAINT spark_ledger_kind_check
 CHECK(kind IN ('reserve','pending','capture','release','starter_grant'));
ALTER TABLE spark_ledger ADD CONSTRAINT spark_ledger_starter_shape CHECK (
 (kind='starter_grant' AND hold_id IS NULL AND amount_subunits=500000
  AND event_key='starter-grant:v1:' || owner_id::text)
 OR (kind<>'starter_grant' AND hold_id IS NOT NULL)
);
CREATE UNIQUE INDEX spark_starter_grant_once ON spark_ledger(owner_id)
 WHERE kind='starter_grant';

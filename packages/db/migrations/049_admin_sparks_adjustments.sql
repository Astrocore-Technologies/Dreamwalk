-- Explicit administrator adjustments only. No legacy conversion, grants or activation here.
ALTER TABLE spark_ledger DROP CONSTRAINT spark_ledger_kind_check;
ALTER TABLE spark_ledger ADD CONSTRAINT spark_ledger_kind_check
 CHECK(kind IN ('reserve','pending','capture','release','starter_grant','admin_credit','admin_debit'));
ALTER TABLE spark_ledger DROP CONSTRAINT spark_ledger_starter_shape;
ALTER TABLE spark_ledger ADD CONSTRAINT spark_ledger_starter_shape CHECK (
 (kind='starter_grant' AND hold_id IS NULL AND amount_subunits=500000
  AND event_key='starter-grant:v1:' || owner_id::text)
 OR (kind IN ('admin_credit','admin_debit') AND hold_id IS NULL AND amount_subunits>0
  AND event_key LIKE 'admin-adjust:v1:%'
  AND evidence ? 'actorId' AND evidence ? 'reason'
  AND jsonb_typeof(evidence->'actorId')='string'
  AND jsonb_typeof(evidence->'reason')='string')
 OR (kind IN ('reserve','pending','capture','release') AND hold_id IS NOT NULL)
);

-- Permit explicit, audited admin issuance. No account is activated or funded here.
-- Preserve every starter/hold constraint and the existing append-only trigger.
ALTER TABLE dream_ledger DROP CONSTRAINT dream_ledger_kind_check;
ALTER TABLE dream_ledger ADD CONSTRAINT dream_ledger_kind_check
 CHECK(kind IN ('reserve','pending','capture','release','starter_grant','admin_credit'));
ALTER TABLE dream_ledger DROP CONSTRAINT dream_ledger_check;
ALTER TABLE dream_ledger ADD CONSTRAINT dream_ledger_check CHECK (
 (kind='starter_grant' AND hold_id IS NULL AND amount_subunits=500000 AND event_key='dream-starter:v1:' || owner_id::text)
 OR (kind='admin_credit' AND jsonb_typeof(evidence)='object' AND hold_id IS NULL AND amount_subunits>0 AND amount_subunits%10000=0
   AND event_key='dream-admin-credit:v1:' || (evidence->>'idempotencyKey')
   AND evidence ?& ARRAY['actorId','reason','amount','idempotencyKey']
   AND jsonb_typeof(evidence->'actorId')='string' AND length(evidence->>'actorId')>0
   AND jsonb_typeof(evidence->'reason')='string' AND length(btrim(evidence->>'reason')) BETWEEN 3 AND 500
   AND jsonb_typeof(evidence->'idempotencyKey')='string' AND length(evidence->>'idempotencyKey') BETWEEN 8 AND 120
   AND jsonb_typeof(evidence->'amount')='number' AND (evidence->>'amount')::numeric=amount_subunits/10000)
 OR (kind IN ('reserve','pending','capture','release') AND hold_id IS NOT NULL)
);

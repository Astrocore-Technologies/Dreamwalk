-- An explicitly approved estimate-risk profile serializes ALL text/image liabilities.
ALTER TABLE generation_budget_scopes ADD COLUMN serialize_outstanding boolean NOT NULL DEFAULT false;
-- Financial receipts survive confirmed deletion of private decision contexts.
ALTER TABLE live_test_text_permits DROP CONSTRAINT live_test_text_permits_request_id_fkey;
ALTER TABLE live_test_text_permits ALTER COLUMN request_id DROP NOT NULL;
ALTER TABLE live_test_text_permits ADD CONSTRAINT live_test_text_permits_request_id_fkey FOREIGN KEY(request_id) REFERENCES game_npc_decision_requests(id) ON DELETE SET NULL;
ALTER TABLE live_test_text_permits ADD COLUMN job_id uuid UNIQUE REFERENCES npc_ai_jobs(id) ON DELETE SET NULL;
UPDATE live_test_text_permits p SET job_id=j.id FROM npc_ai_jobs j WHERE j.request_meta->>'runtimeRequestId'=p.request_id::text;
-- Quotes/jobs retain their original evidence classification, independent of later operator policy.
ALTER TABLE image_generation_quotes ADD COLUMN cost_basis text NOT NULL DEFAULT 'legacy_unknown' CHECK(cost_basis IN ('legacy_unknown','fixture','verified_bound','approved_estimate'));
ALTER TABLE image_generation_quotes ADD COLUMN estimated_total_micros bigint CHECK(estimated_total_micros>=0);
ALTER TABLE image_generation_jobs ADD COLUMN cost_basis text NOT NULL DEFAULT 'legacy_unknown' CHECK(cost_basis IN ('legacy_unknown','fixture','verified_bound','approved_estimate'));
ALTER TABLE image_generation_jobs ADD COLUMN estimated_total_micros bigint CHECK(estimated_total_micros>=0);
UPDATE image_generation_quotes SET cost_basis='fixture' WHERE mode='mock';
UPDATE image_generation_jobs SET cost_basis='fixture' WHERE mode='mock';

-- Supporting-character proposals reuse durable AI receipts/reservations; world admission is atomic.
ALTER TABLE npc_ai_jobs DROP CONSTRAINT npc_ai_jobs_purpose_check;
ALTER TABLE npc_ai_jobs ADD CHECK(purpose IN ('plan','summary','speech','intent','supporting_npc','narrative'));
ALTER TABLE npc_ai_quotes DROP CONSTRAINT npc_ai_quotes_purpose_check;
ALTER TABLE npc_ai_quotes ADD CHECK(purpose IN ('plan','summary','speech','intent','supporting_npc','narrative'));
ALTER TABLE game_npc_decision_requests DROP CONSTRAINT game_npc_decision_requests_purpose_check;
ALTER TABLE game_npc_decision_requests ADD CHECK(purpose IN ('plan','summary','speech','intent','supporting_npc','narrative'));

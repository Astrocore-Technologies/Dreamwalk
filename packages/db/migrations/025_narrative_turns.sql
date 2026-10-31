-- Campaign-local evolving canon: input is not a fact until the world writer commits it.
CREATE TABLE game_narrative_turns (
 id uuid PRIMARY KEY REFERENCES game_npc_decision_requests(id) ON DELETE CASCADE,
 campaign_id uuid NOT NULL REFERENCES game_campaigns(id),
 requester_user_id uuid NOT NULL REFERENCES users(id), actor_id text NOT NULL,
 operation_id uuid NOT NULL, request_hash text NOT NULL,
 expected_canon_revision integer NOT NULL CHECK(expected_canon_revision>=0),
 input_text text NOT NULL CHECK(length(input_text)<=1000),
 status text NOT NULL CHECK(status IN ('pending','committed','stale','failed')),
 quote_id uuid, sponsor_id uuid, consent boolean NOT NULL,
 result jsonb, result_code text, created_at timestamptz NOT NULL DEFAULT now(), committed_at timestamptz,
 UNIQUE(campaign_id,requester_user_id,operation_id)
);
CREATE INDEX narrative_campaign_journal ON game_narrative_turns(campaign_id,created_at);
CREATE TABLE game_narrative_media (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), turn_id uuid NOT NULL REFERENCES game_narrative_turns(id) ON DELETE CASCADE,
 campaign_id uuid NOT NULL REFERENCES game_campaigns(id), map_id text NOT NULL,
 canon_revision integer NOT NULL, specification jsonb NOT NULL,
 status text NOT NULL DEFAULT 'prepared' CHECK(status='prepared'), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(turn_id,map_id)
);
ALTER TABLE game_npc_decision_requests DROP CONSTRAINT game_npc_decision_requests_status_check;
ALTER TABLE game_npc_decision_requests ADD CHECK(status IN ('queued','scheduled','fallback','cancelled','failed','committed'));
ALTER TABLE game_narrative_turns ADD COLUMN expires_at timestamptz NOT NULL DEFAULT (now()+interval '10 minutes');

-- Autonomous NPC speech is a native provider result, not a player-authored story turn.
-- Retain its public delivery independently of the bounded hot utterance window.
ALTER TABLE game_story_feed ALTER COLUMN turn_id DROP NOT NULL;
ALTER TABLE game_story_feed
  ADD COLUMN npc_job_id uuid UNIQUE REFERENCES npc_ai_jobs(id),
  ADD COLUMN npc_request_id uuid;
ALTER TABLE game_story_feed ADD CONSTRAINT story_feed_origin_check CHECK (
  (turn_id IS NOT NULL AND npc_job_id IS NULL AND npc_request_id IS NULL) OR
  (turn_id IS NULL AND npc_job_id IS NOT NULL AND npc_request_id IS NOT NULL)
);
CREATE UNIQUE INDEX story_feed_autonomous_source
  ON game_story_feed(campaign_id,(entry->>'sourceId')) WHERE npc_job_id IS NOT NULL;

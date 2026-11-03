-- API-owned likes, independent of private library favorites. No client SQL grants.
CREATE TABLE adventure_likes (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 adventure_id uuid NOT NULL REFERENCES adventures(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,adventure_id)
);
CREATE INDEX adventure_likes_story_idx ON adventure_likes(adventure_id);
-- Existing event history is authoritative; no invented backfill or mutable counters.
CREATE INDEX game_events_completed_rounds_idx ON game_events(campaign_id)
 WHERE kind IN ('turn.world.completed','round.resolved');
-- Nest is the business-logic owner. Browser/database roles have no direct access.
ALTER TABLE adventure_likes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON adventure_likes FROM PUBLIC;

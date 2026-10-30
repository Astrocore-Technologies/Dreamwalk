-- Server-private personal observations. Never populate from omniscient world events.
CREATE TABLE game_npc_episodes (
  campaign_id uuid NOT NULL REFERENCES game_campaigns(id) ON DELETE CASCADE,
  npc_id text NOT NULL,
  observation_id text NOT NULL,
  root_id text NOT NULL,
  event_id text NOT NULL,
  actor_id text,
  target_id text,
  source_npc_id text,
  observed_tick bigint NOT NULL CHECK(observed_tick>=0),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(campaign_id,npc_id,observation_id)
);
CREATE INDEX game_npc_episodes_recall ON game_npc_episodes(campaign_id,npc_id,observed_tick DESC);
CREATE INDEX game_npc_episodes_actor ON game_npc_episodes(campaign_id,actor_id);
CREATE INDEX game_npc_episodes_target ON game_npc_episodes(campaign_id,target_id);
CREATE INDEX game_npc_episodes_root ON game_npc_episodes(campaign_id,root_id);
-- Corrections are newer beliefs/episodes, not rewriting what was originally perceived.
CREATE FUNCTION guard_npc_episode_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'NPC episode history is immutable';
END $$;
CREATE TRIGGER game_npc_episodes_immutable BEFORE UPDATE ON game_npc_episodes
FOR EACH ROW EXECUTE FUNCTION guard_npc_episode_update();

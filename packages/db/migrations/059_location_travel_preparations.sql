-- Exact pending travel image specification. No arrival is committed before its admitted raster.
CREATE TABLE game_location_travel_preparations (
 id uuid PRIMARY KEY REFERENCES game_story_turns(id) ON DELETE CASCADE,
 campaign_id uuid NOT NULL REFERENCES game_campaigns(id) ON DELETE CASCADE,
 owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 actor_id text NOT NULL,
 source_version_id uuid NOT NULL REFERENCES game_playable_versions(id),
 source_checksum text NOT NULL,
 origin_map_id text NOT NULL,
 canon_revision integer NOT NULL CHECK(canon_revision>=0),
 canon_snapshot jsonb NOT NULL,
 turn_fence jsonb NOT NULL,
 scene jsonb NOT NULL,
 input_hash text NOT NULL,
 image_input jsonb NOT NULL,
 image_quote jsonb,
 image_job_id uuid REFERENCES image_generation_jobs(id),
 batch_id uuid REFERENCES game_world_generation_batches(id),
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','accepted','committed','failed')),
 created_at timestamptz NOT NULL DEFAULT now(),
 committed_at timestamptz
);
CREATE INDEX game_location_travel_pending ON game_location_travel_preparations(campaign_id,state);
ALTER TABLE game_world_generation_batches ADD COLUMN media_entries jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(media_entries)='array');

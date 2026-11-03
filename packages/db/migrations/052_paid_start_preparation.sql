ALTER TABLE visual_authoring_projects ADD COLUMN project_purpose text NOT NULL DEFAULT 'authoring' CHECK(project_purpose IN ('authoring','game-start'));
-- A player's preparation never overwrites the published author source.
CREATE TABLE game_start_preparations (
 id uuid PRIMARY KEY REFERENCES visual_authoring_projects(id),
 actor_id uuid NOT NULL REFERENCES users(id),
 operation_id uuid NOT NULL,
 request_hash text NOT NULL,
 source_version_id uuid NOT NULL REFERENCES game_playable_versions(id),
 source_checksum text NOT NULL,
 hero_id uuid, -- template may be deleted; immutable snapshot remains the consent source
 hero_snapshot jsonb,
 status text NOT NULL CHECK(status IN ('prepared','ready','started')),
 reused boolean NOT NULL,
 compiled jsonb,
 reused_from_id uuid REFERENCES game_start_preparations(id),
 campaign_id uuid UNIQUE REFERENCES game_campaigns(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(actor_id,operation_id),
 CHECK ((status='started') = (campaign_id IS NOT NULL)),
 CHECK (status='prepared' OR reused OR compiled IS NOT NULL)
);
CREATE INDEX game_start_actor ON game_start_preparations(actor_id,created_at DESC);
CREATE FUNCTION preserve_game_start_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
   IF current_setting('dreamwalk.erasure',true)='confirmed' AND (EXISTS(SELECT 1 FROM users WHERE id=OLD.actor_id AND deleted_at IS NOT NULL) OR EXISTS(SELECT 1 FROM game_playable_versions v JOIN adventures a ON a.id=v.adventure_id JOIN users u ON u.id=a.owner_id WHERE v.id=OLD.source_version_id AND u.deleted_at IS NOT NULL)) THEN RETURN OLD; END IF;
   RAISE EXCEPTION 'Game start requires confirmed erasure';
 END IF;
 IF NEW.actor_id IS DISTINCT FROM OLD.actor_id OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
 OR NEW.request_hash IS DISTINCT FROM OLD.request_hash OR NEW.source_version_id IS DISTINCT FROM OLD.source_version_id
 OR NEW.source_checksum IS DISTINCT FROM OLD.source_checksum OR NEW.hero_id IS DISTINCT FROM OLD.hero_id
 OR NEW.reused_from_id IS DISTINCT FROM OLD.reused_from_id
 OR NEW.hero_snapshot IS DISTINCT FROM OLD.hero_snapshot OR NEW.reused IS DISTINCT FROM OLD.reused
 OR (OLD.compiled IS NOT NULL AND NEW.compiled IS DISTINCT FROM OLD.compiled)
 OR (OLD.campaign_id IS NOT NULL AND NEW.campaign_id IS DISTINCT FROM OLD.campaign_id)
 THEN RAISE EXCEPTION 'Immutable game start source'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER game_start_source_immutable BEFORE UPDATE OR DELETE ON game_start_preparations FOR EACH ROW EXECUTE FUNCTION preserve_game_start_source();

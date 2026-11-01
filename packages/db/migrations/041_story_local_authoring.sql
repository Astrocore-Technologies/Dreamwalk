-- New authoring records only: existing stories, invitations and NPC IDs are unchanged.
ALTER TABLE npcs ADD COLUMN story_id uuid REFERENCES adventures(id) ON DELETE CASCADE;
-- Immutable ancestry ID remains meaningful if a library template is later removed.
ALTER TABLE npcs ADD COLUMN source_template_id uuid;
CREATE INDEX npcs_story_scope ON npcs(story_id,owner_id) WHERE story_id IS NOT NULL;
CREATE TABLE story_npc_operations (
 story_id uuid NOT NULL REFERENCES adventures(id) ON DELETE CASCADE,
 request_id uuid NOT NULL, owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 fingerprint text NOT NULL, result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(story_id,request_id)
);
-- A frozen private test is not a release. Only an explicit owner action creates this row.
CREATE TABLE adventure_private_releases (
 id uuid PRIMARY KEY, adventure_id uuid NOT NULL REFERENCES adventures(id) ON DELETE CASCADE,
 playable_version_id uuid NOT NULL REFERENCES game_playable_versions(id),
 owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, operation_id uuid NOT NULL,
 request_hash text NOT NULL, source_edit_revision bigint NOT NULL,
 snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(adventure_id,operation_id), UNIQUE(id,adventure_id)
);
ALTER TABLE adventures ADD COLUMN private_release_id uuid;
ALTER TABLE adventures ADD CONSTRAINT adventure_private_release_scope
 FOREIGN KEY(private_release_id,id) REFERENCES adventure_private_releases(id,adventure_id);
CREATE INDEX private_release_playable ON adventure_private_releases(playable_version_id);
-- Releases are immutable; account erasure can remove parent-owned rows via cascade.
CREATE FUNCTION reject_private_release_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Private releases are immutable'; END $$;
CREATE TRIGGER private_release_immutable BEFORE UPDATE ON adventure_private_releases
 FOR EACH ROW EXECUTE FUNCTION reject_private_release_update();

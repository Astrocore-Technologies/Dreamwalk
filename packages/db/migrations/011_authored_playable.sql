-- Authored game packages are separate from publicly readable narrative DTOs.
CREATE TABLE adventure_game_drafts (
 adventure_id uuid PRIMARY KEY REFERENCES adventures(id),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 draft jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE game_playable_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 adventure_id uuid NOT NULL REFERENCES adventures(id),
 source_revision integer NOT NULL CHECK(source_revision>0),
 audience text NOT NULL CHECK(audience IN ('private','review')),
 package jsonb NOT NULL,
 checksum text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE game_playable_approvals (
 playable_version_id uuid PRIMARY KEY REFERENCES game_playable_versions(id),
 adventure_version_id uuid NOT NULL UNIQUE REFERENCES adventure_versions(id),
 approved_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE adventures ADD COLUMN submitted_game_version_id uuid REFERENCES game_playable_versions(id);
ALTER TABLE game_campaigns ADD COLUMN source_version_id uuid REFERENCES game_playable_versions(id);
CREATE INDEX game_campaign_source_idx ON game_campaigns(source_version_id);
CREATE INDEX game_playable_source_idx ON game_playable_versions(adventure_id,created_at);
CREATE FUNCTION prevent_game_package_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND current_setting('dreamwalk.erasure',true)='confirmed'
 AND NEW.package='{"erased":true}'::jsonb
 AND (to_jsonb(NEW)-'package')=(to_jsonb(OLD)-'package')
 AND EXISTS(SELECT 1 FROM adventures a JOIN users u ON u.id=a.owner_id WHERE a.id=OLD.adventure_id AND u.deleted_at IS NOT NULL)
 THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Immutable playable version';
END; $$;
CREATE TRIGGER game_playable_version_immutable BEFORE UPDATE OR DELETE ON game_playable_versions FOR EACH ROW EXECUTE FUNCTION prevent_game_package_change();
CREATE TRIGGER game_playable_approval_immutable BEFORE UPDATE OR DELETE ON game_playable_approvals FOR EACH ROW EXECUTE FUNCTION prevent_immutable_change();

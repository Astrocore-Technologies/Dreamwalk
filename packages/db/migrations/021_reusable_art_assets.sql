-- Immutable art revisions and explicit reuse grants. Public story visibility is NOT a reuse licence.
CREATE TABLE art_asset_families (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES users(id),
 head_revision integer NOT NULL DEFAULT 0 CHECK(head_revision>=0),archived_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE art_asset_revisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), family_id uuid NOT NULL REFERENCES art_asset_families(id),
 revision integer NOT NULL CHECK(revision>0),upload_id uuid REFERENCES assets(id) ON DELETE SET NULL,
 metadata jsonb NOT NULL,sha256 text NOT NULL,mime text NOT NULL,width integer NOT NULL,height integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(family_id,revision)
);
CREATE INDEX art_asset_revision_metadata ON art_asset_revisions USING gin(metadata);
CREATE TABLE art_asset_grants (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),revision_id uuid NOT NULL REFERENCES art_asset_revisions(id),
 grantor_id uuid NOT NULL REFERENCES users(id),grantee_id uuid REFERENCES users(id),
 retain_existing_pins boolean NOT NULL CHECK(retain_existing_pins),revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX art_asset_live_grant ON art_asset_grants(revision_id,grantee_id) WHERE revoked_at IS NULL;
CREATE INDEX art_asset_grantee ON art_asset_grants(grantee_id,revision_id);
CREATE TABLE art_story_asset_drafts (
 adventure_id uuid PRIMARY KEY REFERENCES adventures(id),revision integer NOT NULL CHECK(revision>0),
 bindings jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE art_playable_manifests (
 playable_version_id uuid PRIMARY KEY REFERENCES game_playable_versions(id),
 adventure_id uuid NOT NULL REFERENCES adventures(id),draft_revision integer NOT NULL,
 checksum text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE art_playable_pins (
 playable_version_id uuid NOT NULL REFERENCES art_playable_manifests(playable_version_id),
 slot text NOT NULL,revision_id uuid NOT NULL REFERENCES art_asset_revisions(id),
 grant_id uuid REFERENCES art_asset_grants(id),rights_snapshot jsonb NOT NULL,
 PRIMARY KEY(playable_version_id,slot)
);
CREATE INDEX art_playable_revision ON art_playable_pins(revision_id,playable_version_id);
CREATE TABLE art_asset_operations (
 user_id uuid NOT NULL REFERENCES users(id),operation_id uuid NOT NULL,request_hash text NOT NULL,
 result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,operation_id)
);
CREATE FUNCTION art_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.upload_id IS NULL AND OLD.upload_id IS NOT NULL
 AND (to_jsonb(NEW)-'upload_id')=(to_jsonb(OLD)-'upload_id')
 AND current_setting('dreamwalk.erasure',true)='confirmed' THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND NEW.metadata='{"erased":true}'::jsonb
 AND (to_jsonb(NEW)-'metadata')=(to_jsonb(OLD)-'metadata')
 AND current_setting('dreamwalk.erasure',true)='confirmed' THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Immutable art asset revision';
END $$;
CREATE TRIGGER art_revision_guard BEFORE UPDATE OR DELETE ON art_asset_revisions FOR EACH ROW EXECUTE FUNCTION art_revision_immutable();
CREATE FUNCTION art_pin_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='art_playable_pins' AND TG_OP='UPDATE' THEN
  IF NEW.slot='erased:'||encode(digest(OLD.slot,'sha256'),'hex') AND NEW.rights_snapshot='{"erased":true}'::jsonb
   AND (to_jsonb(NEW)-'slot'-'rights_snapshot')=(to_jsonb(OLD)-'slot'-'rights_snapshot')
   AND current_setting('dreamwalk.erasure',true)='confirmed'
   AND EXISTS(SELECT 1 FROM game_playable_versions v JOIN adventures a ON a.id=v.adventure_id JOIN users u ON u.id=a.owner_id WHERE v.id=OLD.playable_version_id AND u.deleted_at IS NOT NULL)
   THEN RETURN NEW; END IF;
  IF NEW.rights_snapshot='{"erased":true}'::jsonb AND (to_jsonb(NEW)-'rights_snapshot')=(to_jsonb(OLD)-'rights_snapshot')
   AND current_setting('dreamwalk.erasure',true)='confirmed' THEN RETURN NEW; END IF;
 END IF;
 RAISE EXCEPTION 'Immutable playable art manifest';
END $$;
CREATE TRIGGER art_manifest_guard BEFORE UPDATE OR DELETE ON art_playable_manifests FOR EACH ROW EXECUTE FUNCTION art_pin_immutable();
CREATE TRIGGER art_pin_guard BEFORE UPDATE OR DELETE ON art_playable_pins FOR EACH ROW EXECUTE FUNCTION art_pin_immutable();
CREATE TABLE art_asset_takedowns (
 revision_id uuid PRIMARY KEY REFERENCES art_asset_revisions(id),reason_code text NOT NULL CHECK(reason_code IN ('owner_withdrawal','rights_issue','erasure')),
 created_at timestamptz NOT NULL DEFAULT now()
);

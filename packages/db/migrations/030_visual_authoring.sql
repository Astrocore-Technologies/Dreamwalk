-- Private proposals are separate from shared canon; only explicit apply changes a story.
CREATE TABLE visual_authoring_projects (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id),
 kind text NOT NULL CHECK(kind IN ('character','location')),
 adventure_id uuid REFERENCES adventures(id), brief jsonb NOT NULL, source_hash text NOT NULL, last_applied_source_hash text,
 status text NOT NULL CHECK(status IN ('concept','approved','ready','cancelled')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 plan jsonb, concept_revision_id uuid REFERENCES art_asset_revisions(id),
 preview_state jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX visual_projects_owner ON visual_authoring_projects(owner_id,created_at DESC);
CREATE TABLE visual_package_versions (
 id uuid PRIMARY KEY, project_id uuid NOT NULL UNIQUE REFERENCES visual_authoring_projects(id),
 owner_id uuid NOT NULL REFERENCES users(id), kind text NOT NULL CHECK(kind IN ('character','location')),
 version integer NOT NULL DEFAULT 1, manifest jsonb NOT NULL, plan jsonb, checksum text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE visual_authoring_operations (
 owner_id uuid NOT NULL REFERENCES users(id), operation_id uuid NOT NULL,
 request_hash text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,operation_id)
);
CREATE FUNCTION visual_package_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('dreamwalk.erasure',true)='confirmed'
 AND EXISTS(SELECT 1 FROM users WHERE id=OLD.owner_id AND deleted_at IS NOT NULL)
 THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
 RAISE EXCEPTION 'Immutable visual package';
END $$;
CREATE TRIGGER visual_package_guard BEFORE UPDATE OR DELETE ON visual_package_versions
 FOR EACH ROW EXECUTE FUNCTION visual_package_immutable();

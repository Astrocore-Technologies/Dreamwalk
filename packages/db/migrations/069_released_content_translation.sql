-- Automatic platform-funded translation of RELEASED content. Neither drafts nor
-- gameplay messages create translation events. The outbox contains identifiers,
-- never prose, and commits atomically with its source release.
CREATE TABLE platform_content_translation_events (
 source_kind text NOT NULL CHECK(source_kind IN ('adventure','taxonomy','playable')),
 source_id text NOT NULL,
 generation bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(source_kind,source_id)
);
CREATE TABLE platform_content_translation_cache (
 key text PRIMARY KEY CHECK(key ~ '^[a-f0-9]{64}$'),
 locale text NOT NULL CHECK(locale IN ('ru','uk','en')),
 status text NOT NULL CHECK(status IN ('pending','ready','failed')),
 claim_job_id uuid NOT NULL,
 translated_text text CHECK(length(translated_text) BETWEEN 1 AND 12000),
 erasure_user_ids uuid[] NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 CHECK((status='ready')=(translated_text IS NOT NULL))
);
CREATE TABLE platform_content_translation_bindings (
 source_kind text NOT NULL CHECK(source_kind IN ('adventure','taxonomy','playable')),
 source_id text NOT NULL,
 partition text NOT NULL,
 field_path text NOT NULL,
 locale text NOT NULL CHECK(locale IN ('ru','uk','en')),
 source_digest text NOT NULL,
 cache_keys text[] NOT NULL,
 erasure_user_ids uuid[] NOT NULL DEFAULT '{}',
 PRIMARY KEY(source_kind,source_id,partition,field_path,locale)
);
CREATE INDEX platform_content_bindings_keys ON platform_content_translation_bindings USING gin(cache_keys);
CREATE TABLE platform_content_translation_jobs (
 id uuid PRIMARY KEY,
 source_kind text NOT NULL CHECK(source_kind IN ('adventure','taxonomy','playable')),
 source_id text NOT NULL,
 partition text NOT NULL,
 authority text NOT NULL,
 field_path text NOT NULL,
 locale text NOT NULL CHECK(locale IN ('ru','uk','en')),
 cache_key text NOT NULL,
 erasure_user_ids uuid[] NOT NULL DEFAULT '{}',
 context jsonb,
 provider_version text NOT NULL,
 config_fingerprint text NOT NULL,
 request_snapshot jsonb,
 reservation_id uuid NOT NULL UNIQUE REFERENCES generation_budget_reservations(id),
 status text NOT NULL CHECK(status IN ('queued','dispatched','result_received','ready','failed','unknown','cancelled')),
 result jsonb,
 provider_usage jsonb,
 provider_request_id text,
 error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),
 deadline_at timestamptz,
 completed_at timestamptz
);
CREATE INDEX platform_content_jobs_pending ON platform_content_translation_jobs(status,created_at);
CREATE INDEX platform_content_jobs_source ON platform_content_translation_jobs(source_kind,source_id);
-- Binding removal, source reverts and erasure cannot erase the paid-attempt
-- barrier. Only a proven never-dispatched cancellation permits a replacement.
CREATE UNIQUE INDEX platform_content_paid_once ON platform_content_translation_jobs(cache_key)
 WHERE status<>'cancelled';
CREATE TRIGGER platform_content_usage_immutable BEFORE UPDATE OF provider_usage ON platform_content_translation_jobs
 FOR EACH ROW EXECUTE FUNCTION preserve_generation_provider_usage();

-- Access lifetime is distinct from source prose. Revoke/regrant may never revive
-- a queued authority, while ready exact-text artifacts can be freshly authorized.
ALTER TABLE adventures ADD COLUMN translation_epoch uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE users ADD COLUMN translation_epoch uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE adventure_invitations ADD COLUMN translation_epoch uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE game_campaigns ADD COLUMN translation_epoch uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE game_members ADD COLUMN translation_epoch uuid NOT NULL DEFAULT gen_random_uuid();
CREATE FUNCTION rotate_content_translation_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='users' THEN
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN NEW.translation_epoch:=gen_random_uuid(); END IF;
 ELSIF TG_TABLE_NAME='adventure_invitations' THEN
  IF (NEW.status,NEW.recipient_id,NEW.adventure_id,NEW.owner_id) IS DISTINCT FROM
     (OLD.status,OLD.recipient_id,OLD.adventure_id,OLD.owner_id) THEN NEW.translation_epoch:=gen_random_uuid(); END IF;
 ELSIF TG_TABLE_NAME='game_campaigns' THEN
  IF (NEW.status,NEW.owner_id,NEW.source_version_id) IS DISTINCT FROM
     (OLD.status,OLD.owner_id,OLD.source_version_id) THEN NEW.translation_epoch:=gen_random_uuid(); END IF;
 ELSIF TG_TABLE_NAME='game_members' THEN
  IF (NEW.status,NEW.actor_id) IS DISTINCT FROM (OLD.status,OLD.actor_id)
  THEN NEW.translation_epoch:=gen_random_uuid(); END IF;
 ELSE
  IF (NEW.visibility,NEW.status='archived',NEW.owner_id,NEW.deleted_at,NEW.private_release_id IS NULL,NEW.published_snapshot IS NULL)
     IS DISTINCT FROM
     (OLD.visibility,OLD.status='archived',OLD.owner_id,OLD.deleted_at,OLD.private_release_id IS NULL,OLD.published_snapshot IS NULL)
  THEN NEW.translation_epoch:=gen_random_uuid(); END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER adventure_translation_epoch BEFORE UPDATE ON adventures
 FOR EACH ROW EXECUTE FUNCTION rotate_content_translation_epoch();
CREATE TRIGGER user_translation_epoch BEFORE UPDATE OF deleted_at ON users
 FOR EACH ROW EXECUTE FUNCTION rotate_content_translation_epoch();
CREATE TRIGGER invitation_translation_epoch BEFORE UPDATE ON adventure_invitations
 FOR EACH ROW EXECUTE FUNCTION rotate_content_translation_epoch();
CREATE TRIGGER campaign_translation_epoch BEFORE UPDATE OF status,owner_id,source_version_id ON game_campaigns
 FOR EACH ROW EXECUTE FUNCTION rotate_content_translation_epoch();
CREATE TRIGGER member_translation_epoch BEFORE UPDATE OF status,actor_id ON game_members
 FOR EACH ROW EXECUTE FUNCTION rotate_content_translation_epoch();

CREATE FUNCTION erase_platform_content_translation_user() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE platform_content_translation_jobs SET context=NULL,result=NULL,erasure_user_ids='{}',
  field_path='',partition='erased',authority='erased',source_id=''
  WHERE NEW.id=ANY(erasure_user_ids);
 DELETE FROM platform_content_translation_cache WHERE NEW.id=ANY(erasure_user_ids);
 DELETE FROM platform_content_translation_bindings WHERE NEW.id=ANY(erasure_user_ids);
 RETURN NEW;
END; $$;
CREATE TRIGGER erase_platform_content_translations AFTER UPDATE OF deleted_at ON users
 FOR EACH ROW WHEN (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL)
 EXECUTE FUNCTION erase_platform_content_translation_user();

CREATE FUNCTION mark_content_translation(kind text, id text) RETURNS void LANGUAGE sql AS $$
 INSERT INTO platform_content_translation_events(source_kind,source_id) VALUES(kind,id)
 ON CONFLICT(source_kind,source_id) DO UPDATE SET generation=platform_content_translation_events.generation+1,updated_at=now();
$$;
CREATE FUNCTION queue_released_content_translation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source uuid; version uuid;
BEGIN
 IF TG_TABLE_NAME='platform_settings' THEN
  IF (TG_OP<>'DELETE' AND NEW.key='taxonomy') OR (TG_OP<>'INSERT' AND OLD.key='taxonomy')
  THEN PERFORM mark_content_translation('taxonomy','taxonomy'); END IF;
 ELSIF TG_TABLE_NAME='adventures' THEN
  source:=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
  IF (TG_OP<>'DELETE' AND (NEW.published_snapshot IS NOT NULL OR NEW.private_release_id IS NOT NULL))
     OR (TG_OP<>'INSERT' AND (OLD.published_snapshot IS NOT NULL OR OLD.private_release_id IS NOT NULL)) THEN
   PERFORM mark_content_translation('adventure',source::text);
   FOR version IN SELECT v.id FROM game_playable_versions v WHERE v.adventure_id=source
      AND (EXISTS(SELECT 1 FROM game_playable_approvals p WHERE p.playable_version_id=v.id)
       OR EXISTS(SELECT 1 FROM adventure_private_releases r WHERE r.playable_version_id=v.id))
   LOOP PERFORM mark_content_translation('playable',version::text); END LOOP;
  END IF;
 ELSIF TG_TABLE_NAME='game_playable_approvals' THEN
  version:=CASE WHEN TG_OP='DELETE' THEN OLD.playable_version_id ELSE NEW.playable_version_id END;
  PERFORM mark_content_translation('playable',version::text);
 ELSE
  version:=CASE WHEN TG_OP='DELETE' THEN OLD.playable_version_id ELSE NEW.playable_version_id END;
  source:=CASE WHEN TG_OP='DELETE' THEN OLD.adventure_id ELSE NEW.adventure_id END;
  -- A historical private release can be removed while a newer current pointer
  -- stays nonnull. Fence that grant lifetime and serialize deletion with source
  -- SHARE locks. New releases do not revoke unchanged existing authorities.
  IF TG_OP='DELETE' THEN
   UPDATE adventures SET translation_epoch=gen_random_uuid() WHERE id=source;
  END IF;
  PERFORM mark_content_translation('playable',version::text);
  PERFORM mark_content_translation('adventure',source::text);
 END IF;
 RETURN COALESCE(NEW,OLD);
END; $$;
CREATE TRIGGER released_story_translation_insert AFTER INSERT OR DELETE ON adventures
 FOR EACH ROW EXECUTE FUNCTION queue_released_content_translation();
CREATE TRIGGER released_story_translation_update AFTER UPDATE ON adventures FOR EACH ROW
 WHEN ((NEW.published_snapshot,NEW.private_release_id,NEW.visibility,NEW.status,NEW.owner_id,NEW.deleted_at,NEW.translation_epoch)
   IS DISTINCT FROM (OLD.published_snapshot,OLD.private_release_id,OLD.visibility,OLD.status,OLD.owner_id,OLD.deleted_at,OLD.translation_epoch))
 EXECUTE FUNCTION queue_released_content_translation();
CREATE TRIGGER released_taxonomy_translation AFTER INSERT OR UPDATE OF key,value OR DELETE ON platform_settings
 FOR EACH ROW EXECUTE FUNCTION queue_released_content_translation();
CREATE TRIGGER approved_playable_translation AFTER INSERT OR DELETE ON game_playable_approvals
 FOR EACH ROW EXECUTE FUNCTION queue_released_content_translation();
CREATE TRIGGER private_release_translation AFTER INSERT OR DELETE ON adventure_private_releases
 FOR EACH ROW EXECUTE FUNCTION queue_released_content_translation();

-- One durable event per already released source. No language/user read is needed,
-- no raw content is copied, and workers consume bounded windows until completion.
INSERT INTO platform_content_translation_events(source_kind,source_id)
 SELECT 'adventure',a.id::text FROM adventures a JOIN users u ON u.id=a.owner_id
 WHERE a.deleted_at IS NULL AND u.deleted_at IS NULL AND a.status<>'archived'
 AND (a.published_snapshot IS NOT NULL OR a.private_release_id IS NOT NULL);
INSERT INTO platform_content_translation_events(source_kind,source_id)
 SELECT 'playable',v.id::text FROM game_playable_versions v JOIN adventures a ON a.id=v.adventure_id
 JOIN users u ON u.id=a.owner_id WHERE a.deleted_at IS NULL AND u.deleted_at IS NULL AND a.status<>'archived'
 AND (EXISTS(SELECT 1 FROM game_playable_approvals p WHERE p.playable_version_id=v.id)
 OR EXISTS(SELECT 1 FROM adventure_private_releases r WHERE r.playable_version_id=v.id));
INSERT INTO platform_content_translation_events(source_kind,source_id)
 SELECT 'taxonomy','taxonomy' FROM platform_settings WHERE key='taxonomy';

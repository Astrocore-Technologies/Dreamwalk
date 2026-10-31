-- New confirmed campaign scenes can reuse immutable art without editing the source story.
CREATE TABLE art_campaign_pins (
 campaign_id uuid NOT NULL REFERENCES game_campaigns(id),
 slot text NOT NULL, revision_id uuid NOT NULL REFERENCES art_asset_revisions(id),
 grant_id uuid REFERENCES art_asset_grants(id), rights_snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(campaign_id,slot,revision_id)
);
CREATE INDEX art_campaign_revision ON art_campaign_pins(revision_id,campaign_id);
CREATE FUNCTION art_campaign_pin_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND current_setting('dreamwalk.erasure',true)='confirmed'
 AND NEW.rights_snapshot='{"erased":true}'::jsonb
 AND (to_jsonb(NEW)-'slot'-'rights_snapshot')=(to_jsonb(OLD)-'slot'-'rights_snapshot')
 AND (NEW.slot=OLD.slot OR NEW.slot='erased:'||encode(digest(OLD.slot,'sha256'),'hex'))
 THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Immutable campaign art pin';
END $$;
CREATE TRIGGER art_campaign_pin_guard BEFORE UPDATE OR DELETE ON art_campaign_pins
 FOR EACH ROW EXECUTE FUNCTION art_campaign_pin_immutable();

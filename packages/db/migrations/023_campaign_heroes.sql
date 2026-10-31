-- A saved hero is a template, never the mutable campaign actor.
CREATE TABLE game_member_heroes (
 campaign_id uuid NOT NULL,
 user_id uuid NOT NULL,
 hero_id uuid,
 snapshot jsonb NOT NULL,
 selected_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(campaign_id,user_id),
 FOREIGN KEY(campaign_id,user_id) REFERENCES game_members(campaign_id,user_id) ON DELETE CASCADE
);
CREATE FUNCTION protect_campaign_hero() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Campaign hero selection is immutable'; END IF;
 IF current_setting('dreamwalk.erasure',true) IS DISTINCT FROM 'confirmed' THEN
  RAISE EXCEPTION 'Campaign hero selection requires confirmed erasure';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER campaign_hero_immutable BEFORE UPDATE OR DELETE ON game_member_heroes
 FOR EACH ROW EXECUTE FUNCTION protect_campaign_hero();

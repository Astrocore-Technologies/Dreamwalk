-- A director belongs to a playthrough, not to an account or every campaign.
-- Catalog entries are archived, never deleted, so existing choices remain usable.
ALTER TABLE game_campaigns ADD COLUMN director_profile_id text NOT NULL DEFAULT 'coauthor';
ALTER TABLE game_campaigns ADD COLUMN director_revision integer NOT NULL DEFAULT 1 CHECK(director_revision > 0);
ALTER TABLE game_start_preparations ADD COLUMN director_profile_id text NOT NULL DEFAULT 'coauthor';

CREATE FUNCTION preserve_game_start_director() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.director_profile_id IS DISTINCT FROM OLD.director_profile_id THEN
   RAISE EXCEPTION 'Immutable game start director';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER game_start_director_immutable BEFORE UPDATE ON game_start_preparations FOR EACH ROW EXECUTE FUNCTION preserve_game_start_director();

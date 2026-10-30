-- Independent CAS tokens for narrative/NPC autosave. Playable maps retain their own revision.
ALTER TABLE adventures ADD COLUMN edit_revision bigint NOT NULL DEFAULT 1 CHECK(edit_revision>0);
ALTER TABLE npcs ADD COLUMN edit_revision bigint NOT NULL DEFAULT 1 CHECK(edit_revision>0);
CREATE FUNCTION advance_adventure_edit_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.data IS DISTINCT FROM OLD.data OR NEW.title IS DISTINCT FROM OLD.title
 OR NEW.synopsis IS DISTINCT FROM OLD.synopsis OR NEW.genre IS DISTINCT FROM OLD.genre
 OR NEW.visibility IS DISTINCT FROM OLD.visibility THEN
  NEW.edit_revision:=OLD.edit_revision+1;
 ELSE NEW.edit_revision:=OLD.edit_revision;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER adventure_edit_revision BEFORE UPDATE ON adventures FOR EACH ROW EXECUTE FUNCTION advance_adventure_edit_revision();
CREATE FUNCTION advance_npc_edit_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.data IS DISTINCT FROM OLD.data THEN NEW.edit_revision:=OLD.edit_revision+1;
 ELSE NEW.edit_revision:=OLD.edit_revision;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER npc_edit_revision BEFORE UPDATE ON npcs FOR EACH ROW EXECUTE FUNCTION advance_npc_edit_revision();

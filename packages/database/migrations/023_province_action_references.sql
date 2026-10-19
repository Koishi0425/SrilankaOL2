ALTER TABLE action_object_refs DROP CONSTRAINT action_object_refs_object_type_check;
ALTER TABLE action_object_refs ADD CONSTRAINT action_object_refs_object_type_check
  CHECK (object_type IN ('Tile', 'City', 'Army', 'Country', 'Character', 'Region', 'Province'));

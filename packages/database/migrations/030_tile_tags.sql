-- New campaigns use three knowledge states. Do not convert or delete old campaign data.
ALTER TABLE country_tile_knowledge DROP CONSTRAINT country_tile_knowledge_discovery_state_check;
ALTER TABLE country_tile_knowledge ADD CONSTRAINT country_tile_knowledge_discovery_state_check
  CHECK(discovery_state IN ('Unknown','Mapped','Observed')) NOT VALID;
ALTER TABLE map_reveal_plans DROP CONSTRAINT map_reveal_plans_state_check;
ALTER TABLE map_reveal_plans ADD CONSTRAINT map_reveal_plans_state_check
  CHECK(state IN ('Unknown','Mapped','Observed')) NOT VALID;

CREATE TABLE tile_tags (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  tile_id UUID NOT NULL,
  name TEXT NOT NULL CHECK(char_length(name) BETWEEN 1 AND 60),
  description TEXT NOT NULL DEFAULT '',
  tax_percent INTEGER NOT NULL DEFAULT 0 CHECK(tax_percent BETWEEN -100 AND 300),
  production_percent INTEGER NOT NULL DEFAULT 0 CHECK(production_percent BETWEEN -100 AND 300),
  blocks_observation BOOLEAN NOT NULL DEFAULT FALSE,
  starts_sequence INTEGER NOT NULL CHECK(starts_sequence>=1),
  ends_sequence INTEGER CHECK(ends_sequence>=starts_sequence),
  UNIQUE(game_id,tile_id,name),
  FOREIGN KEY(game_id,tile_id) REFERENCES hex_tiles(game_id,id) ON DELETE CASCADE
);
CREATE INDEX tile_tags_active ON tile_tags(game_id,tile_id,starts_sequence,ends_sequence);

CREATE FUNCTION map_tile_tags(tile UUID) RETURNS JSONB LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',s.id,'name',s.name,'description',s.description,
    'taxPercent',s.tax_percent,'productionPercent',s.production_percent,'blocksObservation',s.blocks_observation,
    'startsSequence',s.starts_sequence,'endsSequence',s.ends_sequence
  ) ORDER BY s.name,s.id),'[]'::jsonb)
  FROM tile_tags s JOIN quarters q ON q.game_id=s.game_id AND q.is_current
  WHERE s.tile_id=tile AND s.starts_sequence<=q.sequence_number AND (s.ends_sequence IS NULL OR s.ends_sequence>=q.sequence_number)
$$;
ALTER FUNCTION map_tile_snapshot(UUID) RENAME TO map_tile_geography_snapshot;
CREATE FUNCTION map_tile_snapshot(tile UUID) RETURNS JSONB LANGUAGE SQL STABLE AS $$
  SELECT map_tile_geography_snapshot(tile)||jsonb_build_object('tags',map_tile_tags(tile))
$$;

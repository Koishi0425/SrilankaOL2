ALTER TABLE country_tile_knowledge
  ADD COLUMN snapshot JSONB,
  ADD COLUMN public_note TEXT NOT NULL DEFAULT '',
  ADD COLUMN observed_at TIMESTAMPTZ;

ALTER TABLE country_army_intelligence
  ADD COLUMN observed_tile_id UUID,
  ADD CONSTRAINT army_intelligence_observed_tile_fk FOREIGN KEY (game_id, observed_tile_id)
    REFERENCES hex_tiles(game_id, id);

CREATE FUNCTION map_tile_snapshot(tile UUID) RETURNS JSONB LANGUAGE SQL STABLE AS $$
  SELECT jsonb_build_object(
    'terrainKey', tt.key, 'terrainName', tt.name, 'terrainColor', tt.color,
    'regionId', r.id, 'regionName', r.name, 'provinceName', p.name,
    'controllerCountryId', c.id, 'controllerCountryName', c.name, 'controllerColor', c.map_color,
    'legalOwnerCountryName', legal.name, 'occupierCountryName', occupier.name,
    'passable', t.passable, 'movementCost', t.movement_cost,
    'elevation', t.elevation, 'roadLevel', t.road_level,
    'cities', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', ci.id, 'name', ci.name, 'importance', ci.importance, 'status', ci.status
    ) ORDER BY ci.name, ci.id) FROM cities ci WHERE ci.game_id = t.game_id AND ci.tile_id = t.id), '[]'::jsonb)
  ) FROM hex_tiles t JOIN terrain_types tt ON tt.id = t.terrain_type_id
    LEFT JOIN regions r ON r.id = t.region_id
    LEFT JOIN provinces p ON p.id = r.province_id
    LEFT JOIN countries c ON c.id = t.controller_country_id
    LEFT JOIN countries legal ON legal.id = t.legal_owner_country_id
    LEFT JOIN countries occupier ON occupier.id = t.occupier_country_id
  WHERE t.id = tile
$$;

-- Earlier releases did not retain historical geography or army positions.
UPDATE country_tile_knowledge SET snapshot = map_tile_snapshot(tile_id), observed_at = updated_at
  WHERE discovery_state <> 'Unknown';
UPDATE country_army_intelligence cai SET observed_tile_id = a.tile_id
  FROM armies a WHERE a.id = cai.army_id AND a.game_id = cai.game_id;

CREATE TABLE map_reveal_plans (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  quarter_id UUID NOT NULL,
  action_id UUID NOT NULL,
  country_id UUID NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('Unknown','Rumored','Discovered','Mapped','Observed','Outdated')),
  note TEXT NOT NULL DEFAULT '' CHECK (char_length(note) <= 2000),
  tile_snapshots JSONB NOT NULL CHECK (jsonb_typeof(tile_snapshots) = 'array'),
  army_reports JSONB,
  army_error_percent INTEGER CHECK (army_error_percent BETWEEN 0 AND 100),
  observed_world_version BIGINT NOT NULL,
  updated_by_user_id UUID NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  UNIQUE(game_id, action_id),
  FOREIGN KEY (game_id, quarter_id) REFERENCES quarters(game_id, id),
  FOREIGN KEY (game_id, action_id) REFERENCES actions(game_id, id),
  FOREIGN KEY (game_id, country_id) REFERENCES countries(game_id, id)
);

CREATE TABLE map_history (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  country_id UUID,
  source_action_id UUID,
  actor_user_id UUID NOT NULL REFERENCES users(id),
  world_version BIGINT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  tile_count INTEGER NOT NULL,
  details JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (game_id, country_id) REFERENCES countries(game_id, id),
  FOREIGN KEY (game_id, source_action_id) REFERENCES actions(game_id, id)
);
CREATE INDEX map_history_country ON map_history(game_id, country_id, created_at DESC, id DESC);

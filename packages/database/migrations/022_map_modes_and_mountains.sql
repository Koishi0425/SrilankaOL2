-- Capture ownership with each observation; existing intelligence and history remain unchanged.
CREATE OR REPLACE FUNCTION map_tile_snapshot(tile UUID) RETURNS JSONB LANGUAGE SQL STABLE AS $$
  SELECT jsonb_build_object(
    'terrainKey', tt.key, 'terrainName', tt.name, 'terrainColor', tt.color,
    'regionId', r.id, 'regionName', r.name, 'provinceName', p.name,
    'controllerCountryId', c.id, 'controllerCountryName', c.name, 'controllerColor', c.map_color,
    'legalOwnerCountryId', legal.id, 'legalOwnerColor', legal.map_color,
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

INSERT INTO terrain_types (id, game_id, key, name, color, movement_cost, passable)
SELECT gen_random_uuid(), game_id, 'mountains', '山地', '#a6a3a0', 3, TRUE FROM world_maps
ON CONFLICT (game_id, key) DO NOTHING;

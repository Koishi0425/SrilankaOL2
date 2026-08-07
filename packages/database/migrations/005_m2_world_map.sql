ALTER TABLE countries
  ADD COLUMN map_color TEXT NOT NULL DEFAULT '#64748b'
  CHECK (map_color ~ '^#[0-9A-Fa-f]{6}$');

CREATE TABLE world_maps (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL UNIQUE REFERENCES games(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  orientation TEXT NOT NULL DEFAULT 'Pointy' CHECK (orientation IN ('Pointy', 'Flat')),
  min_zoom NUMERIC(4,2) NOT NULL DEFAULT 0.5 CHECK (min_zoom > 0),
  max_zoom NUMERIC(4,2) NOT NULL DEFAULT 3 CHECK (max_zoom >= min_zoom),
  asset_version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (game_id, id)
);

CREATE TABLE terrain_types (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  movement_cost NUMERIC(8,2) NOT NULL DEFAULT 1 CHECK (movement_cost > 0),
  passable BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (game_id, id),
  UNIQUE (game_id, key)
);

CREATE TABLE provinces (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  map_id UUID NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  controller_country_id UUID,
  UNIQUE (game_id, id),
  UNIQUE (game_id, name),
  FOREIGN KEY (game_id, map_id) REFERENCES world_maps(game_id, id),
  FOREIGN KEY (game_id, controller_country_id) REFERENCES countries(game_id, id)
);

CREATE TABLE regions (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  map_id UUID NOT NULL,
  province_id UUID,
  name TEXT NOT NULL,
  development_level INTEGER NOT NULL DEFAULT 1 CHECK (development_level >= 0),
  population BIGINT NOT NULL DEFAULT 0 CHECK (population >= 0),
  legal_owner_country_id UUID,
  controller_country_id UUID,
  status TEXT NOT NULL DEFAULT 'Active',
  UNIQUE (game_id, id),
  UNIQUE (game_id, name),
  FOREIGN KEY (game_id, map_id) REFERENCES world_maps(game_id, id),
  FOREIGN KEY (game_id, province_id) REFERENCES provinces(game_id, id),
  FOREIGN KEY (game_id, legal_owner_country_id) REFERENCES countries(game_id, id),
  FOREIGN KEY (game_id, controller_country_id) REFERENCES countries(game_id, id)
);

CREATE TABLE hex_tiles (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  map_id UUID NOT NULL,
  q INTEGER NOT NULL,
  r INTEGER NOT NULL,
  terrain_type_id UUID NOT NULL,
  region_id UUID,
  legal_owner_country_id UUID,
  controller_country_id UUID,
  occupier_country_id UUID,
  elevation INTEGER NOT NULL DEFAULT 0,
  passable BOOLEAN NOT NULL DEFAULT TRUE,
  movement_cost NUMERIC(8,2) NOT NULL DEFAULT 1 CHECK (movement_cost > 0),
  road_level INTEGER NOT NULL DEFAULT 0 CHECK (road_level BETWEEN 0 AND 5),
  notes TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (game_id, id),
  UNIQUE (map_id, q, r),
  FOREIGN KEY (game_id, map_id) REFERENCES world_maps(game_id, id),
  FOREIGN KEY (game_id, terrain_type_id) REFERENCES terrain_types(game_id, id),
  FOREIGN KEY (game_id, region_id) REFERENCES regions(game_id, id),
  FOREIGN KEY (game_id, legal_owner_country_id) REFERENCES countries(game_id, id),
  FOREIGN KEY (game_id, controller_country_id) REFERENCES countries(game_id, id),
  FOREIGN KEY (game_id, occupier_country_id) REFERENCES countries(game_id, id)
);

CREATE INDEX hex_tiles_viewport ON hex_tiles (game_id, q, r);

CREATE TABLE cities (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  tile_id UUID NOT NULL,
  region_id UUID,
  name TEXT NOT NULL,
  controller_country_id UUID,
  status TEXT NOT NULL DEFAULT 'Normal',
  importance INTEGER NOT NULL DEFAULT 1 CHECK (importance BETWEEN 1 AND 5),
  UNIQUE (game_id, id),
  UNIQUE (game_id, name),
  FOREIGN KEY (game_id, tile_id) REFERENCES hex_tiles(game_id, id),
  FOREIGN KEY (game_id, region_id) REFERENCES regions(game_id, id),
  FOREIGN KEY (game_id, controller_country_id) REFERENCES countries(game_id, id)
);

CREATE INDEX cities_tile_lookup ON cities (game_id, tile_id);

CREATE TABLE armies (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  country_id UUID NOT NULL,
  tile_id UUID NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Ready',
  strength INTEGER NOT NULL DEFAULT 0 CHECK (strength >= 0),
  morale INTEGER NOT NULL DEFAULT 100 CHECK (morale BETWEEN 0 AND 100),
  UNIQUE (game_id, id),
  FOREIGN KEY (game_id, country_id) REFERENCES countries(game_id, id),
  FOREIGN KEY (game_id, tile_id) REFERENCES hex_tiles(game_id, id)
);

CREATE INDEX armies_tile_lookup ON armies (game_id, tile_id);

CREATE TABLE military_units (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  army_id UUID NOT NULL,
  name TEXT NOT NULL,
  unit_type TEXT NOT NULL,
  personnel INTEGER NOT NULL DEFAULT 0 CHECK (personnel >= 0),
  status TEXT NOT NULL DEFAULT 'Ready',
  FOREIGN KEY (game_id, army_id) REFERENCES armies(game_id, id)
);

CREATE TABLE buildings (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  city_id UUID NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Active',
  FOREIGN KEY (game_id, city_id) REFERENCES cities(game_id, id)
);

CREATE TABLE characters (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  country_id UUID,
  tile_id UUID,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Active',
  administration INTEGER NOT NULL DEFAULT 0,
  diplomacy INTEGER NOT NULL DEFAULT 0,
  military INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (game_id, country_id) REFERENCES countries(game_id, id),
  FOREIGN KEY (game_id, tile_id) REFERENCES hex_tiles(game_id, id)
);

CREATE TABLE status_effects (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  target_id UUID NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'General',
  status TEXT NOT NULL DEFAULT 'Active',
  is_permanent BOOLEAN NOT NULL DEFAULT FALSE,
  public_description TEXT NOT NULL DEFAULT '',
  host_description TEXT NOT NULL DEFAULT ''
);

CREATE INDEX status_effects_target ON status_effects (game_id, target_type, target_id);

CREATE TABLE custom_property_definitions (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  object_type TEXT NOT NULL,
  data_type TEXT NOT NULL,
  UNIQUE (game_id, id),
  UNIQUE (game_id, key, object_type)
);

CREATE TABLE custom_property_values (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  definition_id UUID NOT NULL,
  object_id UUID NOT NULL,
  value JSONB NOT NULL,
  UNIQUE (definition_id, object_id),
  FOREIGN KEY (game_id, definition_id)
    REFERENCES custom_property_definitions(game_id, id) ON DELETE CASCADE
);

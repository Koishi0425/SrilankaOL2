ALTER TABLE provinces
  ADD COLUMN tax_base INTEGER NOT NULL DEFAULT 0 CHECK (tax_base BETWEEN 0 AND 1000000),
  ADD COLUMN production_base INTEGER NOT NULL DEFAULT 0 CHECK (production_base BETWEEN 0 AND 1000000),
  ADD COLUMN manpower_base INTEGER NOT NULL DEFAULT 0 CHECK (manpower_base BETWEEN 0 AND 1000000),
  ADD COLUMN autonomy NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (autonomy BETWEEN 0 AND 100),
  ADD COLUMN unrest NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (unrest BETWEEN -100 AND 100),
  ADD COLUMN profile_revision INTEGER NOT NULL DEFAULT 0 CHECK (profile_revision >= 0);

CREATE INDEX regions_province_lookup ON regions(game_id,province_id);
CREATE INDEX hex_tiles_region_lookup ON hex_tiles(game_id,region_id);

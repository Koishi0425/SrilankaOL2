ALTER TABLE games ALTER COLUMN economic_rules SET DEFAULT '{"enabled":false,"taxCoefficient":0,"productionCoefficient":0,"manpowerCoefficient":0,"armyMaintenancePer100":0,"administrationCost":0,"tradeCoefficient":0}'::jsonb;
UPDATE games SET economic_rules=jsonb_build_object('tradeCoefficient',0)||economic_rules WHERE NOT economic_rules ? 'tradeCoefficient';
CREATE TABLE trade_zones (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  UNIQUE(game_id,id),
  UNIQUE(game_id,name)
);
CREATE TABLE trade_zone_provinces (
  game_id UUID NOT NULL,
  zone_id UUID NOT NULL,
  province_id UUID NOT NULL,
  PRIMARY KEY(game_id,province_id),
  FOREIGN KEY(game_id,zone_id) REFERENCES trade_zones(game_id,id) ON DELETE CASCADE,
  FOREIGN KEY(game_id,province_id) REFERENCES provinces(game_id,id) ON DELETE CASCADE
);
CREATE INDEX trade_zone_provinces_zone ON trade_zone_provinces(game_id,zone_id);
CREATE TABLE trade_influences (
  game_id UUID NOT NULL,
  zone_id UUID NOT NULL,
  country_id UUID NOT NULL,
  power NUMERIC(12,2) NOT NULL CHECK(power>=0 AND power<=1000000),
  PRIMARY KEY(game_id,zone_id,country_id),
  FOREIGN KEY(game_id,zone_id) REFERENCES trade_zones(game_id,id) ON DELETE CASCADE,
  FOREIGN KEY(game_id,country_id) REFERENCES countries(game_id,id) ON DELETE CASCADE
);

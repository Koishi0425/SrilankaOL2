CREATE TABLE country_tile_knowledge (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  country_id UUID NOT NULL,
  tile_id UUID NOT NULL,
  discovery_state TEXT NOT NULL
    CHECK (discovery_state IN ('Unknown', 'Rumored', 'Discovered', 'Mapped', 'Observed', 'Outdated')),
  confidence INTEGER CHECK (confidence BETWEEN 0 AND 100),
  observed_world_version BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (game_id, country_id, tile_id),
  FOREIGN KEY (game_id, country_id) REFERENCES countries(game_id, id),
  FOREIGN KEY (game_id, tile_id) REFERENCES hex_tiles(game_id, id)
);

CREATE INDEX country_tile_knowledge_lookup
  ON country_tile_knowledge (game_id, country_id, discovery_state, tile_id);

CREATE TABLE country_army_intelligence (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  country_id UUID NOT NULL,
  army_id UUID NOT NULL,
  perceived_name TEXT,
  perceived_country_id UUID,
  strength_min INTEGER CHECK (strength_min >= 0),
  strength_max INTEGER CHECK (strength_max >= strength_min),
  confidence INTEGER CHECK (confidence BETWEEN 0 AND 100),
  observed_world_version BIGINT,
  is_outdated BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (game_id, country_id, army_id),
  FOREIGN KEY (game_id, country_id) REFERENCES countries(game_id, id),
  FOREIGN KEY (game_id, army_id) REFERENCES armies(game_id, id),
  FOREIGN KEY (game_id, perceived_country_id) REFERENCES countries(game_id, id),
  CHECK ((strength_min IS NULL) = (strength_max IS NULL))
);

CREATE INDEX country_army_intelligence_lookup
  ON country_army_intelligence (game_id, country_id, army_id);

-- Existing development worlds start with stable geography available to every
-- country, while only controlled territory has current dynamic information.
INSERT INTO country_tile_knowledge (
  id, game_id, country_id, tile_id, discovery_state, confidence,
  observed_world_version
)
SELECT gen_random_uuid(), c.game_id, c.id, t.id,
       CASE WHEN t.controller_country_id = c.id THEN 'Observed' ELSE 'Mapped' END,
       CASE WHEN t.controller_country_id = c.id THEN 100 ELSE 80 END,
       CASE WHEN t.controller_country_id = c.id THEN g.current_world_version ELSE NULL END
FROM countries c
JOIN games g ON g.id = c.game_id
JOIN hex_tiles t ON t.game_id = c.game_id
ON CONFLICT (game_id, country_id, tile_id) DO NOTHING;

-- Give development countries a deliberately imprecise report about enemy
-- armies so player-view differences can be verified immediately.
INSERT INTO country_army_intelligence (
  id, game_id, country_id, army_id, perceived_name, perceived_country_id,
  strength_min, strength_max, confidence, observed_world_version
)
SELECT gen_random_uuid(), c.game_id, c.id, a.id, a.name, a.country_id,
       FLOOR(a.strength * 0.75)::integer,
       CEIL(a.strength * 1.25)::integer,
       65, g.current_world_version
FROM countries c
JOIN games g ON g.id = c.game_id
JOIN armies a ON a.game_id = c.game_id AND a.country_id <> c.id
ON CONFLICT (game_id, country_id, army_id) DO NOTHING;

ALTER TABLE games ADD COLUMN diplomacy_revision INTEGER NOT NULL DEFAULT 0 CHECK(diplomacy_revision>=0);
ALTER TABLE quarter_settlements ADD COLUMN diplomacy_changes JSONB NOT NULL DEFAULT '[]'::jsonb;
CREATE TABLE diplomatic_relations (
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  country_a UUID NOT NULL,
  country_b UUID NOT NULL,
  record JSONB NOT NULL,
  PRIMARY KEY(game_id,country_a,country_b),
  CHECK(country_a<country_b),
  FOREIGN KEY(game_id,country_a) REFERENCES countries(game_id,id) ON DELETE CASCADE,
  FOREIGN KEY(game_id,country_b) REFERENCES countries(game_id,id) ON DELETE CASCADE
);
CREATE TABLE diplomatic_treaties (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  record JSONB NOT NULL,
  UNIQUE(game_id,id)
);
CREATE TABLE diplomacy_history (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL,
  quarter_id UUID NOT NULL,
  actor_user_id UUID NOT NULL REFERENCES users(id),
  operation TEXT NOT NULL CHECK(operation IN ('Setup','Settlement')),
  change JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY(game_id,quarter_id) REFERENCES quarters(game_id,id) ON DELETE CASCADE
);
CREATE INDEX diplomacy_history_game ON diplomacy_history(game_id,created_at DESC,id);

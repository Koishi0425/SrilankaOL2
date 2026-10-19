ALTER TABLE games ADD COLUMN government_revision INTEGER NOT NULL DEFAULT 0 CHECK(government_revision>=0);
ALTER TABLE quarter_settlements ADD COLUMN government_changes JSONB NOT NULL DEFAULT '[]'::jsonb;
CREATE TABLE country_governments (
  game_id UUID NOT NULL,
  country_id UUID NOT NULL,
  record JSONB NOT NULL,
  PRIMARY KEY(game_id,country_id),
  FOREIGN KEY(game_id,country_id) REFERENCES countries(game_id,id) ON DELETE CASCADE
);
CREATE TABLE national_policies (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL,
  country_id UUID NOT NULL,
  record JSONB NOT NULL,
  FOREIGN KEY(game_id,country_id) REFERENCES countries(game_id,id) ON DELETE CASCADE
);
CREATE INDEX national_policies_country ON national_policies(game_id,country_id);
CREATE TABLE government_history (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL,
  country_id UUID NOT NULL,
  quarter_id UUID NOT NULL,
  actor_user_id UUID NOT NULL REFERENCES users(id),
  operation TEXT NOT NULL CHECK(operation IN ('Setup','Settlement')),
  change JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY(game_id,country_id) REFERENCES countries(game_id,id) ON DELETE CASCADE,
  FOREIGN KEY(game_id,quarter_id) REFERENCES quarters(game_id,id) ON DELETE CASCADE
);
CREATE INDEX government_history_country ON government_history(game_id,country_id,created_at DESC,id);

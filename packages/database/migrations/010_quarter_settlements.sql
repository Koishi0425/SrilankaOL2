CREATE TABLE quarter_settlements (
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  quarter_id UUID NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  public_report TEXT NOT NULL DEFAULT '' CHECK (char_length(public_report) <= 20000),
  results JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(results) = 'array'),
  published_snapshot JSONB,
  published_at TIMESTAMPTZ,
  updated_by_user_id UUID NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (game_id, quarter_id),
  FOREIGN KEY (game_id, quarter_id) REFERENCES quarters(game_id, id),
  CHECK ((published_at IS NULL) = (published_snapshot IS NULL))
);

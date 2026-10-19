ALTER TABLE countries
  ADD COLUMN treasury NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (treasury BETWEEN -1000000000 AND 1000000000),
  ADD COLUMN manpower INTEGER NOT NULL DEFAULT 0 CHECK (manpower >= 0),
  ADD COLUMN resource_revision INTEGER NOT NULL DEFAULT 0 CHECK (resource_revision >= 0);

ALTER TABLE quarter_settlements
  ADD COLUMN resource_changes JSONB NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(resource_changes) = 'array');

CREATE TABLE country_resource_ledger (
  id BIGSERIAL PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  country_id UUID NOT NULL,
  quarter_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('Setup', 'Settlement')),
  change_id UUID NOT NULL,
  resource TEXT NOT NULL CHECK (resource IN ('Treasury', 'Manpower')),
  amount NUMERIC(12,2) NOT NULL,
  before_balance NUMERIC(12,2) NOT NULL,
  after_balance NUMERIC(12,2) NOT NULL,
  reason TEXT NOT NULL,
  actor_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (game_id, change_id, resource),
  FOREIGN KEY (game_id, country_id) REFERENCES countries(game_id, id),
  FOREIGN KEY (quarter_id) REFERENCES quarters(id)
);
CREATE INDEX country_resource_ledger_page ON country_resource_ledger (game_id, country_id, id DESC);

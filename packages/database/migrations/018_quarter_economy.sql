ALTER TABLE games
  ADD COLUMN economic_rules JSONB NOT NULL DEFAULT '{"enabled":false,"taxCoefficient":0,"productionCoefficient":0,"manpowerCoefficient":0,"armyMaintenancePer100":0,"administrationCost":0}'::jsonb CHECK (jsonb_typeof(economic_rules)='object'),
  ADD COLUMN economic_rules_revision INTEGER NOT NULL DEFAULT 0 CHECK (economic_rules_revision>=0);
ALTER TABLE quarters ADD COLUMN economic_snapshot JSONB CHECK (economic_snapshot IS NULL OR jsonb_typeof(economic_snapshot)='object');
ALTER TABLE quarter_settlements ADD COLUMN economic_bill JSONB CHECK (economic_bill IS NULL OR jsonb_typeof(economic_bill)='object');
CREATE TABLE economic_rule_history (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  quarter_id UUID NOT NULL,
  actor_user_id UUID NOT NULL REFERENCES users(id),
  previous_rules JSONB NOT NULL,
  next_rules JSONB NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (game_id,quarter_id) REFERENCES quarters(game_id,id)
);

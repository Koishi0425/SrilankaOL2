ALTER TABLE quarter_settlements
  ADD COLUMN battles JSONB NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(battles) = 'array');

-- Rolls survive draft removal, so retrying a request never generates new dice.
CREATE TABLE settlement_battle_rolls (
  game_id UUID NOT NULL,
  quarter_id UUID NOT NULL,
  battle_id UUID NOT NULL,
  idempotency_key UUID NOT NULL,
  sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
  request JSONB NOT NULL,
  result JSONB NOT NULL,
  actor_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (game_id, quarter_id, battle_id, idempotency_key),
  UNIQUE (game_id, quarter_id, battle_id, sequence_number),
  FOREIGN KEY (game_id, quarter_id) REFERENCES quarter_settlements(game_id, quarter_id) ON DELETE CASCADE
);

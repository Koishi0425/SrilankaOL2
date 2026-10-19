ALTER TABLE country_resource_ledger DROP CONSTRAINT country_resource_ledger_kind_check;
ALTER TABLE country_resource_ledger ADD CONSTRAINT country_resource_ledger_kind_check
  CHECK (kind IN ('Setup', 'Settlement', 'Correction'));

CREATE TABLE settlement_corrections (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(id),
  quarter_id UUID NOT NULL,
  applied_quarter_id UUID NOT NULL,
  sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
  kind TEXT NOT NULL CHECK (kind IN ('PublicReport','ActionFeedback','Resource','ArmyStrength')),
  country_id UUID,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 2000),
  data JSONB NOT NULL,
  request JSONB NOT NULL,
  actor_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (game_id,quarter_id,sequence_number),
  FOREIGN KEY (game_id,quarter_id) REFERENCES quarters(game_id,id),
  FOREIGN KEY (game_id,applied_quarter_id) REFERENCES quarters(game_id,id),
  FOREIGN KEY (game_id,country_id) REFERENCES countries(game_id,id)
);
CREATE TRIGGER game_content_read_only BEFORE INSERT OR UPDATE OR DELETE ON settlement_corrections
FOR EACH ROW EXECUTE FUNCTION guard_game_content();

CREATE FUNCTION guard_settlement_correction_history() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Correction history is append-only' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER settlement_correction_immutable BEFORE UPDATE OR DELETE ON settlement_corrections
FOR EACH ROW EXECUTE FUNCTION guard_settlement_correction_history();

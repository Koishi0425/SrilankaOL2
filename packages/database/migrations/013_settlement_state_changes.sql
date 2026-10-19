ALTER TABLE quarter_settlements
  ADD COLUMN state_changes JSONB NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(state_changes) = 'array');

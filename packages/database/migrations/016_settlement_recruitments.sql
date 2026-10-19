ALTER TABLE quarter_settlements
  ADD COLUMN recruitments JSONB NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(recruitments) = 'array');

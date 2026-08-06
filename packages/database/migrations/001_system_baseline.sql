CREATE TABLE IF NOT EXISTS system_metadata (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO system_metadata (key, value)
VALUES ('schema_baseline', '{"version": 1}'::jsonb)
ON CONFLICT (key) DO NOTHING;

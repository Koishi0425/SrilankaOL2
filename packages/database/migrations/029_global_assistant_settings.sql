CREATE TABLE assistant_global_settings (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  enabled BOOLEAN NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('deepseek','glm','compatible')),
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  api_key_ciphertext TEXT NOT NULL,
  json_mode BOOLEAN NOT NULL,
  disable_thinking BOOLEAN NOT NULL,
  timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 1000 AND 120000),
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The bootstrap account used to have the default User role. Only installations
-- without any system administrator adopt their original, still-active account.
UPDATE users SET system_role = 'Administrator', updated_at = NOW()
WHERE id = (SELECT id FROM users ORDER BY created_at, id LIMIT 1)
  AND status = 'Active'
  AND NOT EXISTS (SELECT 1 FROM users WHERE system_role = 'Administrator');

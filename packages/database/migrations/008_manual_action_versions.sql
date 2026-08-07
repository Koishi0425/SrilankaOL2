ALTER TABLE action_versions
  ADD COLUMN is_manual BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN action_versions.is_manual IS
  'TRUE for player-confirmed snapshots; FALSE for legacy automatic-save versions.';

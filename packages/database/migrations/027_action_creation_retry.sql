ALTER TABLE actions
  ADD COLUMN creation_id UUID,
  ADD COLUMN creation_fingerprint CHAR(64);
CREATE UNIQUE INDEX actions_creation_request
  ON actions(game_id,created_by_member_id,creation_id) WHERE creation_id IS NOT NULL;

-- Existing action IDs, formal texts, discussions and settlement references stay intact.
-- An action is now a section inside its author's quarterly policy submission.
ALTER TABLE actions
  ADD COLUMN draft_removed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN draft_order INTEGER NOT NULL DEFAULT 0 CHECK (draft_order >= 0);
ALTER TABLE action_submissions
  ADD COLUMN submission_group_id UUID,
  ADD COLUMN section_order INTEGER NOT NULL DEFAULT 0 CHECK (section_order >= 0);
CREATE INDEX actions_round_submission
  ON actions(game_id, quarter_id, created_by_member_id, country_id, draft_order, created_at);

CREATE TABLE round_policy_requests (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(id),
  quarter_id UUID NOT NULL,
  member_id UUID NOT NULL,
  country_id UUID NOT NULL,
  actor_user_id UUID NOT NULL REFERENCES users(id),
  fingerprint CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY(game_id,quarter_id) REFERENCES quarters(game_id,id),
  FOREIGN KEY(game_id,member_id) REFERENCES game_members(game_id,id),
  FOREIGN KEY(game_id,country_id) REFERENCES countries(game_id,id)
);
CREATE TRIGGER game_content_read_only BEFORE INSERT OR UPDATE OR DELETE ON round_policy_requests
FOR EACH ROW EXECUTE FUNCTION guard_game_content();

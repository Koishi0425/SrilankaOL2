ALTER TABLE quarters
  ADD COLUMN action_rules JSONB NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(action_rules) = 'object');

ALTER TABLE actions DROP CONSTRAINT actions_category_check;
ALTER TABLE actions ADD CONSTRAINT actions_category_check CHECK (category IN (
  'Exploration', 'EventResponse', 'Policy', 'Reform', 'Diplomacy', 'Construction',
  'Research', 'Recruitment', 'Military', 'Intelligence', 'Custom'
));

CREATE TABLE game_rule_history (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  quarter_id UUID NOT NULL,
  actor_user_id UUID NOT NULL REFERENCES users(id),
  previous_rules JSONB NOT NULL,
  next_rules JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (game_id, quarter_id) REFERENCES quarters(game_id, id)
);

CREATE TABLE action_submissions (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL,
  action_id UUID NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  category TEXT NOT NULL,
  secrecy TEXT NOT NULL,
  refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (game_id, action_id) REFERENCES actions(game_id, id) ON DELETE CASCADE
);

CREATE INDEX action_submissions_history
  ON action_submissions (game_id, action_id, submitted_at DESC, id DESC);

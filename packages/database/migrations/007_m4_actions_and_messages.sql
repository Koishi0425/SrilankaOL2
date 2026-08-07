ALTER TABLE game_members ADD CONSTRAINT game_members_game_id_id_unique UNIQUE (game_id, id);
ALTER TABLE quarters ADD CONSTRAINT quarters_game_id_id_unique UNIQUE (game_id, id);

CREATE TABLE actions (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  quarter_id UUID NOT NULL,
  country_id UUID NOT NULL,
  created_by_member_id UUID NOT NULL,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  category TEXT NOT NULL CHECK (category IN (
    'EventResponse', 'Policy', 'Reform', 'Diplomacy', 'Construction',
    'Research', 'Recruitment', 'Military', 'Intelligence', 'Custom'
  )),
  current_text TEXT NOT NULL CHECK (char_length(current_text) <= 20000),
  submitted_original_text TEXT,
  secrecy TEXT NOT NULL CHECK (secrecy IN ('OwnerOnly', 'Participants', 'Public')),
  status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN (
    'Draft', 'Submitted', 'HostReview', 'NeedPlayerInput', 'AIStructuring',
    'PendingHostApproval', 'PendingPlayerConfirmation', 'Approved', 'Rejected',
    'Resolving', 'Completed', 'Withdrawn', 'Invalidated'
  )),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  submit_idempotency_key UUID,
  submitted_at TIMESTAMPTZ,
  withdrawn_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (game_id, id),
  UNIQUE (game_id, submit_idempotency_key),
  FOREIGN KEY (game_id, quarter_id) REFERENCES quarters(game_id, id),
  FOREIGN KEY (game_id, country_id) REFERENCES countries(game_id, id),
  FOREIGN KEY (game_id, created_by_member_id) REFERENCES game_members(game_id, id)
);

CREATE INDEX actions_owner_queue ON actions (game_id, country_id, quarter_id, status, updated_at DESC);
CREATE INDEX actions_host_queue ON actions (game_id, quarter_id, status, submitted_at);

CREATE TABLE action_versions (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL,
  action_id UUID NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  title TEXT NOT NULL,
  original_text TEXT NOT NULL,
  category TEXT NOT NULL,
  secrecy TEXT NOT NULL,
  edited_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (action_id, version),
  FOREIGN KEY (game_id, action_id) REFERENCES actions(game_id, id) ON DELETE CASCADE
);

CREATE TABLE action_object_refs (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL,
  action_id UUID NOT NULL,
  ref_kind TEXT NOT NULL CHECK (ref_kind IN ('Actor', 'Target', 'Context')),
  object_type TEXT NOT NULL CHECK (object_type IN ('Tile', 'City', 'Army', 'Country', 'Character', 'Region')),
  object_id UUID NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  UNIQUE (action_id, ref_kind, object_type, object_id),
  FOREIGN KEY (game_id, action_id) REFERENCES actions(game_id, id) ON DELETE CASCADE
);

CREATE TABLE action_interpretations (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL,
  action_id UUID NOT NULL,
  text TEXT NOT NULL CHECK (char_length(text) BETWEEN 1 AND 20000),
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (game_id, action_id) REFERENCES actions(game_id, id) ON DELETE CASCADE
);

CREATE TABLE action_input_requests (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL,
  action_id UUID NOT NULL,
  message TEXT NOT NULL CHECK (char_length(message) BETWEEN 1 AND 4000),
  status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Answered', 'Cancelled')),
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at TIMESTAMPTZ,
  FOREIGN KEY (game_id, action_id) REFERENCES actions(game_id, id) ON DELETE CASCADE
);

CREATE TABLE action_status_history (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL,
  action_id UUID NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_user_id UUID NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (game_id, action_id) REFERENCES actions(game_id, id) ON DELETE CASCADE
);

CREATE TABLE quarter_state_history (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  quarter_id UUID NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  actor_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (game_id, quarter_id) REFERENCES quarters(game_id, id)
);

CREATE TABLE conversations (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('HostPlayer', 'BilateralDiplomacy', 'Multilateral', 'ActionReview')),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Closed', 'Archived')),
  created_by_member_id UUID NOT NULL,
  linked_object_type TEXT,
  linked_object_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at TIMESTAMPTZ,
  UNIQUE (game_id, id),
  FOREIGN KEY (game_id, created_by_member_id) REFERENCES game_members(game_id, id)
);

CREATE TABLE conversation_participants (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  member_id UUID NOT NULL,
  is_moderator BOOLEAN NOT NULL DEFAULT FALSE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (conversation_id, member_id),
  FOREIGN KEY (game_id, conversation_id) REFERENCES conversations(game_id, id) ON DELETE CASCADE,
  FOREIGN KEY (game_id, member_id) REFERENCES game_members(game_id, id)
);

CREATE TABLE messages (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  sender_member_id UUID NOT NULL,
  content TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 10000),
  client_message_id UUID NOT NULL,
  linked_object_type TEXT,
  linked_object_id UUID,
  is_invalidated BOOLEAN NOT NULL DEFAULT FALSE,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (conversation_id, client_message_id),
  UNIQUE (game_id, id),
  FOREIGN KEY (game_id, conversation_id) REFERENCES conversations(game_id, id) ON DELETE CASCADE,
  FOREIGN KEY (game_id, sender_member_id) REFERENCES game_members(game_id, id)
);

CREATE INDEX messages_cursor ON messages (conversation_id, sent_at DESC, id DESC);
CREATE INDEX conversation_participant_lookup ON conversation_participants (game_id, member_id, conversation_id);

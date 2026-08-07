CREATE TABLE users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  system_role TEXT NOT NULL DEFAULT 'User'
    CHECK (system_role IN ('User', 'Administrator')),
  status TEXT NOT NULL DEFAULT 'Active'
    CHECK (status IN ('Active', 'Suspended', 'Archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX users_email_unique ON users (LOWER(email));

CREATE TABLE auth_sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX auth_sessions_active_lookup
  ON auth_sessions (token_hash, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE games (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Preparing'
    CHECK (status IN ('Preparing', 'Running', 'Paused', 'Correcting', 'Completed', 'Archived')),
  host_user_id UUID NOT NULL REFERENCES users(id),
  current_year INTEGER NOT NULL DEFAULT 1,
  current_season TEXT NOT NULL DEFAULT 'Spring'
    CHECK (current_season IN ('Spring', 'Summer', 'Autumn', 'Winter')),
  current_world_version BIGINT NOT NULL DEFAULT 0,
  allow_new_players BOOLEAN NOT NULL DEFAULT TRUE,
  ai_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ
);

CREATE TABLE countries (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Active'
    CHECK (status IN ('Active', 'Inactive', 'Archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (game_id, id),
  UNIQUE (game_id, name)
);

CREATE TABLE game_members (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL
    CHECK (role IN ('Host', 'Player', 'Observer', 'Administrator')),
  status TEXT NOT NULL DEFAULT 'Active'
    CHECK (status IN ('Invited', 'Active', 'Left', 'Suspended')),
  controlled_country_id UUID,
  special_permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (game_id, user_id),
  FOREIGN KEY (game_id, controlled_country_id)
    REFERENCES countries(game_id, id)
);

CREATE INDEX game_members_user_lookup
  ON game_members (user_id, status, game_id);

CREATE TABLE quarters (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  game_year INTEGER NOT NULL,
  season TEXT NOT NULL
    CHECK (season IN ('Spring', 'Summer', 'Autumn', 'Winter')),
  sequence_number INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'Preparing'
    CHECK (state IN (
      'Preparing', 'EventResponse', 'ActionSubmission', 'Locked',
      'HostReview', 'AIProcessing', 'Resolving', 'PendingPublication',
      'Published', 'DisputeReview', 'Correcting', 'Completed'
    )),
  is_current BOOLEAN NOT NULL DEFAULT TRUE,
  started_at TIMESTAMPTZ,
  action_deadline TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  base_world_version BIGINT NOT NULL DEFAULT 0,
  published_world_version BIGINT,
  was_rolled_back BOOLEAN NOT NULL DEFAULT FALSE,
  correction_version INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (game_id, sequence_number)
);

CREATE UNIQUE INDEX quarters_one_current_per_game
  ON quarters (game_id)
  WHERE is_current = TRUE;

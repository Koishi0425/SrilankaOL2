ALTER TABLE users ADD COLUMN password_changed_at TIMESTAMPTZ;

-- These are account security records, not mutable game content. Their source
-- identifies the host's authority, which is rechecked when a code is redeemed.
CREATE TABLE account_reset_codes (
  id UUID PRIMARY KEY,
  target_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issuer_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  source_game_id UUID REFERENCES games(id) ON DELETE CASCADE,
  code_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX account_reset_codes_target ON account_reset_codes(target_user_id);

CREATE TABLE registration_invitations (
  id UUID PRIMARY KEY,
  source_game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  issuer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  used_by_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE account_security_events (
  id BIGSERIAL PRIMARY KEY,
  actor_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  target_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  source_game_id UUID REFERENCES games(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('PasswordChanged','ResetIssued','PasswordReset','InviteIssued','InviteUsed','OperatorResetIssued')),
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX account_security_events_game ON account_security_events(source_game_id,created_at DESC);

CREATE TABLE auth_rate_limits (
  bucket CHAR(64) PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX auth_rate_limits_expiry ON auth_rate_limits(expires_at);
CREATE INDEX registration_invitations_issuer ON registration_invitations(issuer_user_id);

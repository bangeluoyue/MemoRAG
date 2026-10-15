BEGIN;

CREATE TABLE IF NOT EXISTS memorag_users (
  email VARCHAR(254) PRIMARY KEY,
  role VARCHAR(16) NOT NULL,
  notes_user_id VARCHAR(128) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT memorag_users_role_check CHECK (role IN ('admin', 'tester'))
);

CREATE TABLE IF NOT EXISTS memorag_sessions (
  session_digest CHAR(64) PRIMARY KEY,
  user_email VARCHAR(254) NOT NULL REFERENCES memorag_users(email) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS memorag_sessions_user_idx
  ON memorag_sessions (user_email);

CREATE INDEX IF NOT EXISTS memorag_sessions_expiry_idx
  ON memorag_sessions (expires_at);

COMMIT;

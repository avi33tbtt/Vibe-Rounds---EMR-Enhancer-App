-- 002_auth.sql (chunk 32a): server-side sessions and a last-login stamp. 001_core.sql already has users.password_hash, role check,
-- active, failed_logins, locked_until and must_change_password, and a unique index on lower(username).
ALTER TABLE users ADD COLUMN last_login_at timestamptz;
ALTER TABLE users ADD CONSTRAINT users_hash_format CHECK (password_hash IS NULL OR password_hash LIKE 'scrypt$%');
ALTER TABLE users ADD CONSTRAINT users_username_shape CHECK (username ~ '^[A-Za-z0-9._@-]{1,100}$');

-- The browser holds a random token in an httpOnly cookie; only its SHA-256 is stored, so a database leak does not leak live sessions.
CREATE TABLE sessions (
  id          text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
  user_id     uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,                       -- absolute limit, never extended
  CHECK (expires_at > created_at)
);
CREATE INDEX sessions_user_ix ON sessions (user_id);
CREATE INDEX sessions_expires_ix ON sessions (expires_at);

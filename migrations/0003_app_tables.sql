-- App tables. docs/architecture.md#data-model
-- Timestamps are integer epoch milliseconds. user_id references Better Auth's "user".
-- No credential values are ever stored in audit_log (docs/auth-and-security.md#secrets).

CREATE TABLE client_settings (
  user_id TEXT PRIMARY KEY REFERENCES "user" ("id") ON DELETE CASCADE,
  size_usd INTEGER NOT NULL CHECK (size_usd > 0),
  stop_pct REAL NOT NULL CHECK (stop_pct > 0),
  trailing_unlock_pct REAL NOT NULL CHECK (trailing_unlock_pct > 0),
  updated_at INTEGER NOT NULL
);

-- Activation links: only the HMAC of the token is stored. created_by is history, like
-- audit_log.actor_id: deleting an admin must not fail on, or cascade to, the links they made.
CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  revoked_at INTEGER,
  created_by TEXT NOT NULL
);
CREATE INDEX invitations_user_id_idx ON invitations (user_id);

-- Single use is enforced by an atomic UPDATE ... WHERE used_at IS NULL.
CREATE TABLE recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at INTEGER,
  UNIQUE (user_id, code_hash)
);

-- Secret and refresh token are AES-GCM ciphertext written and read only by the engine Worker.
-- refresh_expires_at NULL means unknown or non-expiring.
CREATE TABLE broker_connection (
  user_id TEXT PRIMARY KEY REFERENCES "user" ("id") ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  client_secret_enc TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  key_id TEXT NOT NULL,
  refresh_expires_at INTEGER,
  status TEXT NOT NULL,
  last_ok_at INTEGER
);

-- Audit rows outlive the users they mention, so actor_id and target_user_id are plain text.
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_user_id TEXT,
  before_json TEXT,
  after_json TEXT
);
CREATE INDEX audit_log_target_idx ON audit_log (target_user_id, at);

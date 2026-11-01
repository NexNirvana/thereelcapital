-- Lock 3 of REAL mode (docs/decisions.md D52, D49): a live account trades for one client only. The
-- first client whose connection lists a live account binds it; the engine writes it with
-- INSERT ... ON CONFLICT DO NOTHING and then reads the owner, so two clients racing for the same
-- account (a shared login) agree on one winner. Rows go when the client disconnects or is removed.
CREATE TABLE real_account_bindings (
  account_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX real_account_bindings_user_id_idx ON real_account_bindings (user_id);

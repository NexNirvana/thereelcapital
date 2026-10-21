// DO SQLite schema: docs/architecture.md#data-model. Prices are integer micro-dollars
// (src/lib/domain/money.ts); `mode` separates SIM from REAL on every table.

/**
 * Append-only: a migration already shipped is never edited, a new one is added. Applied in order
 * inside the constructor's `blockConcurrencyWhile`, so no request sees a half-built schema.
 */
const MIGRATIONS: readonly (readonly string[])[] = [
  [
    `CREATE TABLE entry_counters (
       mode TEXT NOT NULL CHECK (mode IN ('SIM', 'REAL')),
       session_date TEXT NOT NULL,
       consumed INTEGER NOT NULL DEFAULT 0 CHECK (consumed >= 0),
       reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
       PRIMARY KEY (mode, session_date)
     ) STRICT`,
    `CREATE TABLE intents (
       id TEXT PRIMARY KEY,
       mode TEXT NOT NULL CHECK (mode IN ('SIM', 'REAL')),
       kind TEXT NOT NULL CHECK (kind IN ('entry', 'exit', 'stop', 'trailing', 'cancel')),
       account_id TEXT NOT NULL,
       position_id TEXT,
       symbol TEXT NOT NULL,
       asset_type TEXT NOT NULL,
       trade_action TEXT NOT NULL,
       qty INTEGER NOT NULL CHECK (qty > 0),
       size_applied INTEGER,
       quote_json TEXT,
       state TEXT NOT NULL CHECK (state IN ('ARMED', 'SENT', 'ACKNOWLEDGED', 'PARTIAL', 'FILLED',
         'CANCEL_PENDING', 'CANCELED', 'REJECTED', 'UNKNOWN')),
       order_confirm_id TEXT NOT NULL UNIQUE,
       broker_order_id TEXT,
       filled_qty INTEGER NOT NULL DEFAULT 0 CHECK (filled_qty >= 0),
       avg_fill_price INTEGER,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     ) STRICT`,
    `CREATE INDEX intents_by_mode_state ON intents (mode, state)`,
    `CREATE TABLE positions (
       id TEXT PRIMARY KEY,
       mode TEXT NOT NULL CHECK (mode IN ('SIM', 'REAL')),
       account_id TEXT NOT NULL,
       symbol TEXT NOT NULL,
       underlying TEXT,
       expiry TEXT,
       strike INTEGER,
       right TEXT,
       point_value INTEGER NOT NULL DEFAULT 1,
       original_qty INTEGER NOT NULL CHECK (original_qty > 0),
       sold_qty INTEGER NOT NULL DEFAULT 0 CHECK (sold_qty >= 0),
       avg_entry_price INTEGER NOT NULL,
       stop_pct INTEGER NOT NULL,
       trailing_unlock_pct INTEGER NOT NULL,
       trailing_pct INTEGER,
       trailing_peak INTEGER,
       trailing_level INTEGER,
       protection_state TEXT NOT NULL,
       status TEXT NOT NULL,
       opened_on TEXT NOT NULL
     ) STRICT`,
    `CREATE INDEX positions_by_mode_status ON positions (mode, status)`,
    // The docs list no mode here; issue #16 asks for it on every table, so the step carries its
    // position's mode and a query can scope by it without a join.
    `CREATE TABLE scaleout_steps (
       position_id TEXT NOT NULL REFERENCES positions (id),
       mode TEXT NOT NULL CHECK (mode IN ('SIM', 'REAL')),
       idx INTEGER NOT NULL CHECK (idx BETWEEN 0 AND 6),
       state TEXT NOT NULL CHECK (state IN ('available', 'pending', 'done', 'done_zero')),
       intent_id TEXT REFERENCES intents (id),
       PRIMARY KEY (position_id, idx)
     ) STRICT`,
    `CREATE TABLE events (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       at INTEGER NOT NULL,
       mode TEXT NOT NULL CHECK (mode IN ('SIM', 'REAL')),
       level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
       type TEXT NOT NULL,
       message TEXT NOT NULL,
       data_json TEXT
     ) STRICT`,
  ],
  [
    // One authorization in flight per client: the state is single use and expires, and the secret
    // waits here encrypted until TradeStation sends the browser back with the code.
    `CREATE TABLE oauth_attempts (
       state TEXT PRIMARY KEY,
       mode TEXT NOT NULL CHECK (mode IN ('SIM', 'REAL')),
       client_id TEXT NOT NULL,
       client_secret_enc TEXT NOT NULL,
       key_id TEXT NOT NULL,
       expires_at INTEGER NOT NULL
     ) STRICT`,
    // Active Cash and Margin accounts the key can see, as listed when the client connected.
    `CREATE TABLE broker_accounts (
       mode TEXT NOT NULL CHECK (mode IN ('SIM', 'REAL')),
       account_id TEXT NOT NULL,
       account_type TEXT NOT NULL CHECK (account_type IN ('Cash', 'Margin')),
       PRIMARY KEY (mode, account_id)
     ) STRICT`,
  ],
];

/** Idempotent: applies only the migrations above the recorded version, atomically. */
export function migrate(storage: DurableObjectStorage): void {
  storage.transactionSync(() => {
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY) STRICT",
    );
    const applied = storage.sql
      .exec<{ latest: number }>("SELECT COALESCE(MAX(version), 0) AS latest FROM schema_migrations")
      .one().latest;
    MIGRATIONS.slice(applied).forEach((statements, offset) => {
      for (const statement of statements) storage.sql.exec(statement);
      storage.sql.exec("INSERT INTO schema_migrations (version) VALUES (?)", applied + offset + 1);
    });
  });
}

-- Lock 2 of REAL mode (docs/decisions.md D52): the admin turns REAL on per client. Off for every
-- existing client; nothing reads the flag yet, the engine will.
ALTER TABLE client_settings
  ADD COLUMN real_trading_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (real_trading_enabled IN (0, 1));

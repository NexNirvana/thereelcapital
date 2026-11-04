-- D53: the admin may let a client choose the SIZE of one entry (whole dollars, 1 up to their SIZE).
-- Off for every existing client; the engine reads it from here at prepare and at send.
ALTER TABLE client_settings
  ADD COLUMN client_sets_size INTEGER NOT NULL DEFAULT 0
  CHECK (client_sets_size IN (0, 1));

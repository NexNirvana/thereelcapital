-- The daily limit of new entries becomes a per-client setting the admin edits next to SIZE, stop %
-- and the trailing threshold (docs/decisions.md D48). Existing clients keep the previous fixed
-- limit of 3. The bounds mirror DAILY_ENTRIES_BOUNDS in src/lib/domain/guards.ts.
ALTER TABLE client_settings
  ADD COLUMN max_daily_entries INTEGER NOT NULL DEFAULT 3
  CHECK (max_daily_entries BETWEEN 1 AND 1000);

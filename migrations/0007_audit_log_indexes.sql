-- The audit page (src/lib/server/admin-audit.ts) pages by (at DESC, id DESC), optionally filtered by
-- actor or action, and lists the distinct actors and actions on every load. Each index ends in the
-- sort key so the page needs no sort, and its leading column serves the DISTINCT scan and the filter.
CREATE INDEX audit_log_at_idx ON audit_log (at DESC, id DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id, at DESC, id DESC);
CREATE INDEX audit_log_action_idx ON audit_log (action, at DESC, id DESC);

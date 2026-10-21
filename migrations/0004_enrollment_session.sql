-- Enrollment-only sessions (docs/auth-and-security.md#flows): a session created from a recovery
-- code or an activation link that may register a passkey and nothing else. Enforced centrally in
-- src/hooks.server.ts through src/lib/server/enrollment.ts. Existing sessions are full sessions.
ALTER TABLE "session" ADD COLUMN "enrollment" integer NOT NULL DEFAULT 0;

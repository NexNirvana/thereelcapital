-- The activation link an enrollment session was created from, so that using, regenerating or
-- revoking the link can end exactly those sessions (docs/auth-and-security.md#flows). NULL for
-- full sessions and for sessions created from a recovery code. Deleting a link ends its sessions.
ALTER TABLE "session" ADD COLUMN "invitationId" text REFERENCES invitations ("id") ON DELETE CASCADE;
CREATE INDEX session_invitationId_idx ON "session" ("invitationId");

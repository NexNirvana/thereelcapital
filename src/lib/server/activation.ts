// Activation links (docs/auth-and-security.md#flows). Only the SHA-256 of a token is stored, in
// `invitations`; the plaintext exists once, in the response that shows it to the admin. Every
// state change is one atomic statement (or batch) that rechecks the conditions it depends on, so
// concurrent opens, registrations, regenerations and revocations cannot both win.
import { APIError, getSessionFromCtx } from "better-auth/api";
import type { GenericEndpointContext } from "better-auth";
import {
  DEFAULT_SIZE_USD,
  DEFAULT_STOP_PCT,
  DEFAULT_TRAILING_UNLOCK_PCT,
} from "#lib/domain/config.ts";
import { activationErrors } from "#lib/auth-messages.ts";
import { auditStatement, type AuditDb } from "./audit.ts";
import type { Auth } from "./auth.ts";
import { createEnrollmentSession, grantEnrollmentCookie } from "./enrollment-session.ts";
import { newInvitation } from "./activation-link.ts";
import { hashActivationToken } from "./token-hash.ts";

// The slice of D1 used here; D1Database satisfies it and tests run it on SQLite.
export interface ActivationStatement {
  run(): Promise<{ meta: { changes: number } }>;
  first(): Promise<Record<string, unknown> | null>;
}
export interface ActivationDb<S extends ActivationStatement> extends AuditDb<S> {
  batch(statements: S[]): Promise<unknown>;
}

type Actor = { user: { id: string } };

const notBanned = `user_id IN (SELECT "id" FROM "user" WHERE "banned" IS NOT 1)`;
// A link that can still be used; the one `?` is "now".
const openLink = `used_at IS NULL AND revoked_at IS NULL AND expires_at > ? AND ${notBanned}`;

/**
 * The link behind `token` when it can still be used: unused, unexpired, not revoked and its
 * client not suspended. Looked up by hash, so no token is compared in application code. A read
 * only; the link is spent when the passkey registers (`claimInvitation`).
 */
export async function findOpenInvitation<S extends ActivationStatement>(
  db: ActivationDb<S>,
  token: string,
  now = Date.now(),
): Promise<{ invitationId: string; userId: string } | null> {
  const row = await db
    .prepare(`SELECT id, user_id FROM invitations WHERE token_hash = ? AND ${openLink}`)
    .bind(await hashActivationToken(token), now)
    .first();
  return typeof row?.id === "string" && typeof row.user_id === "string"
    ? { invitationId: row.id, userId: row.user_id }
    : null;
}

/**
 * Whether `invitationId` is the link behind `token`: a reload of /activar/<token> may resume an
 * enrollment session only when it came from this very link, not from another one.
 */
export async function isLinkOfToken<S extends ActivationStatement>(
  db: ActivationDb<S>,
  invitationId: string,
  token: string,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS found FROM invitations WHERE id = ? AND token_hash = ?")
    .bind(invitationId, await hashActivationToken(token))
    .first();
  return row !== null;
}

/**
 * Ends the client's other sessions, but only while the link is still open: the delete carries
 * the check in the same statement, so a request delayed past the client's own activation cannot
 * sign them out. Returns whether the link is open afterwards.
 */
export async function endOtherSessionsWhileOpen<S extends ActivationStatement>(
  db: ActivationDb<S>,
  { invitationId, userId, keepToken }: { invitationId: string; userId: string; keepToken: string },
  now = Date.now(),
): Promise<boolean> {
  await db
    .prepare(
      `DELETE FROM "session" WHERE "userId" = ? AND "token" != ?
       AND EXISTS (SELECT 1 FROM invitations WHERE id = ? AND ${openLink})`,
    )
    .bind(userId, keepToken, invitationId, now)
    .run();
  const stillOpen = await db
    .prepare(`SELECT 1 AS found FROM invitations WHERE id = ? AND ${openLink}`)
    .bind(invitationId, now)
    .first();
  return stillOpen !== null;
}

/**
 * Opens an enrollment session for an open link and ends the client's other sessions. Returns
 * false (nothing granted, own session removed) when the link closed meanwhile, so it can leave
 * neither a signed-out client nor a session on a spent link.
 */
export async function startActivationSession<S extends ActivationStatement>(
  ctx: GenericEndpointContext,
  db: ActivationDb<S>,
  { invitationId, userId }: { invitationId: string; userId: string },
): Promise<boolean> {
  const created = await createEnrollmentSession(ctx, userId, { invitationId });
  const { token } = created.session;
  if (!(await endOtherSessionsWhileOpen(db, { invitationId, userId, keepToken: token }))) {
    await db.prepare('DELETE FROM "session" WHERE "token" = ?').bind(token).run();
    return false;
  }
  await grantEnrollmentCookie(ctx, created);
  return true;
}

/**
 * Spends the link for the client's first passkey: one UPDATE rechecks everything, so two
 * registrations racing on one link (or one racing a regeneration) cannot both pass. On success
 * it ends every other enrollment session of the link and writes the audit row in one batch; if
 * that fails the link is given back, because nothing was granted.
 */
export async function claimInvitation<S extends ActivationStatement>(
  db: ActivationDb<S>,
  {
    invitationId,
    userId,
    sessionToken,
  }: { invitationId: string; userId: string; sessionToken: string },
  now = Date.now(),
): Promise<boolean> {
  const claimed = await db
    .prepare(
      `UPDATE invitations SET used_at = ? WHERE id = ? AND user_id = ? AND ${openLink} RETURNING id`,
    )
    .bind(now, invitationId, userId, now)
    .first();
  if (claimed === null) return false;
  try {
    await db.batch([
      db
        .prepare('DELETE FROM "session" WHERE "invitationId" = ? AND "token" != ?')
        .bind(invitationId, sessionToken),
      auditStatement(
        db,
        {
          actor: { user: { id: userId } },
          action: "activation.complete",
          targetUserId: userId,
          before: { linkUsed: false },
          after: { linkUsed: true },
        },
        now,
      ),
    ]);
  } catch (failure) {
    await db
      .prepare("UPDATE invitations SET used_at = NULL WHERE id = ? AND used_at = ?")
      .bind(invitationId, now)
      .run();
    throw failure;
  }
  return true;
}

/**
 * Runs inside the passkey registration of an enrollment session that came from an activation
 * link: a failed claim throws before the passkey is stored. Other sessions (recovery) pass.
 */
export async function claimActivationOnRegistration<S extends ActivationStatement>(
  db: ActivationDb<S>,
  ctx: GenericEndpointContext,
): Promise<void> {
  const current = await getSessionFromCtx(ctx);
  const invitationId = current?.session.invitationId;
  if (!current?.session.enrollment || typeof invitationId !== "string") return;
  const ok = await claimInvitation(db, {
    invitationId,
    userId: current.user.id,
    sessionToken: current.session.token,
  });
  if (!ok) throw APIError.from("UNAUTHORIZED", activationErrors.invalidLink);
}

/** What an admin screen needs to show once; nothing else about the token is kept. */
export interface IssuedLink {
  token: string;
  expiresAt: number;
}

export interface CreateClientDeps<S extends ActivationStatement> {
  db: ActivationDb<S>;
  /** `auth.api.createUser` without headers: a server-side call, no password, no public route. */
  createUser: (email: string) => Promise<{ id: string }>;
}

/** `createClient`'s user step on the real auth instance: no password, no headers, role `user`. */
export function createUserWith(auth: Auth): CreateClientDeps<ActivationStatement>["createUser"] {
  return async (email) => {
    const { user } = await auth.api.createUser({ body: { email, name: email, role: "user" } });
    return { id: user.id };
  };
}

/**
 * Creates a client: the user, the default settings and the first activation link, with one audit
 * row. Server function only (the admin screen, #32, calls it after `requireAdmin` and
 * `requireFreshSession`); no public route reaches it. No email is sent.
 */
export async function createClient<S extends ActivationStatement>(
  { db, createUser }: CreateClientDeps<S>,
  actor: Actor,
  email: string,
  now = Date.now(),
): Promise<IssuedLink & { userId: string }> {
  const { id: userId } = await createUser(email);
  const link = await newInvitation(now);
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO client_settings (user_id, size_usd, stop_pct, trailing_unlock_pct, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(userId, DEFAULT_SIZE_USD, DEFAULT_STOP_PCT, DEFAULT_TRAILING_UNLOCK_PCT, now),
      insertInvitation(db, userId, link, actor),
      auditStatement(
        db,
        {
          actor,
          action: "client.create",
          targetUserId: userId,
          before: null,
          after: {
            sizeUsd: DEFAULT_SIZE_USD,
            stopPct: DEFAULT_STOP_PCT,
            trailingUnlockPct: DEFAULT_TRAILING_UNLOCK_PCT,
          },
        },
        now,
      ),
    ]);
  } catch (failure) {
    // The user exists but has no settings or link: remove it so the email can be used again.
    await db.prepare('DELETE FROM "user" WHERE "id" = ?').bind(userId).run();
    throw failure;
  }
  return { userId, token: link.token, expiresAt: link.expiresAt };
}

export function insertInvitation<S extends ActivationStatement>(
  db: ActivationDb<S>,
  userId: string,
  link: { tokenHash: string; expiresAt: number },
  actor: Actor,
) {
  return db
    .prepare(
      `INSERT INTO invitations (id, user_id, token_hash, expires_at, created_by)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), userId, link.tokenHash, link.expiresAt, actor.user.id);
}

/**
 * Revokes the client's unused links and ends the enrollment sessions created from them, in one
 * batch with the audit row. A link that was already spent is left alone, and so is the session
 * that spent it: that client has a passkey and may finish.
 */
function revocationStatements<S extends ActivationStatement>(
  db: ActivationDb<S>,
  actor: Actor,
  userId: string,
  action: string,
  now: number,
) {
  return [
    db
      .prepare(
        `UPDATE invitations SET revoked_at = ?
         WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL`,
      )
      .bind(now, userId),
    db
      .prepare(
        `DELETE FROM "session"
         WHERE "invitationId" IN (SELECT id FROM invitations WHERE user_id = ? AND revoked_at = ?)`,
      )
      .bind(userId, now),
    auditStatement(
      db,
      {
        actor,
        action,
        targetUserId: userId,
        before: { linkOpen: true },
        after: { linkOpen: false },
      },
      now,
    ),
  ];
}

export async function revokeActivationLink<S extends ActivationStatement>(
  db: ActivationDb<S>,
  actor: Actor,
  userId: string,
  now = Date.now(),
): Promise<void> {
  await db.batch(revocationStatements(db, actor, userId, "activation_link.revoke", now));
}

/** Replaces the client's open link with a new one; the old one and its sessions stop working. */
export async function regenerateActivationLink<S extends ActivationStatement>(
  db: ActivationDb<S>,
  actor: Actor,
  userId: string,
  now = Date.now(),
): Promise<IssuedLink> {
  const link = await newInvitation(now);
  await db.batch([
    ...revocationStatements(db, actor, userId, "activation_link.regenerate", now),
    insertInvitation(db, userId, link, actor),
  ]);
  return { token: link.token, expiresAt: link.expiresAt };
}

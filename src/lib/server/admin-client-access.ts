// The admin client detail page's reads and mutations (docs/screens-and-flows.md#admin): access,
// activation link, sessions and controlled recovery (docs/auth-and-security.md#flows). The actor is
// always the session admin from the guards; the only request values are the target client's id
// (from the URL, checked to be a client) and the session id to revoke. Each mutation is one D1
// batch with its audit row, so either everything lands or nothing does. Broker orders are never
// touched: nothing here reaches the engine.
import { error, isHttpError } from "@sveltejs/kit";
import { Schema } from "effect";
import {
  insertInvitation,
  regenerateActivationLink,
  revokeActivationLink,
  type ActivationStatement,
  type IssuedLink,
} from "./activation.ts";
import { newInvitation } from "./activation-link.ts";
import { type AuditDb } from "./audit.ts";
import { decode } from "./decode.ts";
import {
  guardErrors,
  requireAdmin,
  requireFreshSession,
  type Authenticated,
  type GuardEvent,
  type GuardLocals,
} from "./guards.ts";

export interface AccessStatement extends ActivationStatement {
  all(): Promise<{ results: unknown[] }>;
}
export interface AccessDb<S extends AccessStatement> extends AuditDb<S> {
  batch(statements: S[]): Promise<{ meta: { changes: number } }[]>;
}

export const accessErrors = {
  clientDisabled: {
    status: 409,
    code: "CLIENT_DISABLED",
    message: "El cliente está desactivado. Reactívalo antes de generar un enlace.",
  },
  alreadyEnrolled: {
    status: 409,
    code: "ALREADY_ENROLLED",
    message:
      "El cliente ya tiene passkey. Para volver a darle acceso usa la recuperación controlada.",
  },
  noOpenLink: {
    status: 409,
    code: "NO_OPEN_LINK",
    message: "El cliente no tiene un enlace vigente.",
  },
  alreadyDisabled: {
    status: 409,
    code: "ALREADY_DISABLED",
    message: "El cliente ya está desactivado.",
  },
  notDisabled: { status: 409, code: "NOT_DISABLED", message: "El cliente no está desactivado." },
  sessionGone: { status: 409, code: "SESSION_GONE", message: "Esa sesión ya no existe." },
  noSessions: {
    status: 409,
    code: "NO_SESSIONS",
    message: "El cliente no tiene sesiones abiertas.",
  },
  unconfirmed: {
    status: 400,
    code: "UNCONFIRMED",
    message: "Confirma que verificaste la identidad del cliente fuera de la app.",
  },
} as const;

type Failure = (typeof accessErrors)[keyof typeof accessErrors] | typeof guardErrors.reauthRequired;
export type Outcome<T = Record<never, never>> = ({ ok: true } & T) | { ok: false; error: Failure };

// Better Auth ids are opaque short strings; anything else cannot be a client's id.
const ClientId = Schema.String.check(Schema.isMaxLength(64), Schema.isPattern(/^[A-Za-z0-9_-]+$/));

const toMillis = (value: unknown) =>
  typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
const Instant = Schema.Union([Schema.Number, Schema.String]);

const Profile = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  name: Schema.String,
  role: Schema.NullOr(Schema.String),
  banned: Schema.NullOr(Schema.Number),
  passkeys: Schema.Number,
  unusedCodes: Schema.Number,
});
const SessionRow = Schema.Struct({
  id: Schema.String,
  createdAt: Instant,
  expiresAt: Instant,
  userAgent: Schema.NullOr(Schema.String),
  enrollment: Schema.NullOr(Schema.Number),
});
const LinkRow = Schema.Struct({
  expiresAt: Schema.Number,
  usedAt: Schema.NullOr(Schema.Number),
  revokedAt: Schema.NullOr(Schema.Number),
});

export type LinkState = "none" | "open" | "used" | "expired" | "revoked";
export interface ClientDetail {
  id: string;
  email: string;
  name: string;
  role: "user";
  access: "invited" | "active" | "disabled";
  passkeys: number;
  unusedCodes: number;
  link: { state: LinkState; expiresAt: number | null };
  sessions: readonly {
    id: string;
    createdAt: number;
    expiresAt: number;
    userAgent: string | null;
    enrollment: boolean;
  }[];
}

type Target = { id: string; email: string; banned: boolean; passkeys: number };

async function loadTarget<S extends AccessStatement>(db: AccessDb<S>, rawId: string) {
  const id = decode(ClientId, rawId);
  const row = await db
    .prepare(
      `SELECT u."id" AS id, u."email" AS email, u."name" AS name, u."role" AS role, u."banned" AS banned,
         (SELECT COUNT(*) FROM "passkey" WHERE "userId" = u."id") AS passkeys,
         (SELECT COUNT(*) FROM recovery_codes WHERE user_id = u."id" AND used_at IS NULL) AS unusedCodes
       FROM "user" u WHERE u."id" = ?`,
    )
    .bind(id)
    .first();
  const profile = row === null ? null : Schema.decodeUnknownSync(Profile)(row);
  // Admins are not clients: they are never a target, and look the same as a missing id.
  if (profile === null || profile.role !== "user")
    error(404, "Cliente no encontrado.", { code: "NOT_FOUND" });
  return profile;
}

/** The detail page's data. Hashes, tokens and credential material are never selected. */
export async function getClientDetail<S extends AccessStatement>(
  db: AccessDb<S>,
  rawId: string,
  now = Date.now(),
): Promise<ClientDetail> {
  const profile = await loadTarget(db, rawId);
  const [sessions, links] = await Promise.all([
    db
      .prepare(
        `SELECT "id" AS id, "createdAt" AS createdAt, "expiresAt" AS expiresAt, "userAgent" AS userAgent,
           "enrollment" AS enrollment
         FROM "session" WHERE "userId" = ? ORDER BY "createdAt" DESC`,
      )
      .bind(profile.id)
      .all(),
    db
      .prepare(
        `SELECT expires_at AS expiresAt, used_at AS usedAt, revoked_at AS revokedAt
         FROM invitations WHERE user_id = ? ORDER BY rowid DESC LIMIT 1`,
      )
      .bind(profile.id)
      .all(),
  ]);
  const [latest] = Schema.decodeUnknownSync(Schema.Array(LinkRow))(links.results);
  const linkState: LinkState = !latest
    ? "none"
    : latest.usedAt !== null
      ? "used"
      : latest.revokedAt !== null
        ? "revoked"
        : latest.expiresAt <= now
          ? "expired"
          : "open";
  return {
    id: profile.id,
    email: profile.email,
    name: profile.name,
    role: "user",
    access: profile.banned === 1 ? "disabled" : profile.passkeys > 0 ? "active" : "invited",
    passkeys: profile.passkeys,
    unusedCodes: profile.unusedCodes,
    link: { state: linkState, expiresAt: latest?.expiresAt ?? null },
    sessions: Schema.decodeUnknownSync(Schema.Array(SessionRow))(sessions.results)
      .map((session) => ({
        ...session,
        createdAt: toMillis(session.createdAt),
        expiresAt: toMillis(session.expiresAt),
        enrollment: session.enrollment === 1,
      }))
      .filter((session) => session.expiresAt > now),
  };
}

type Actor = Authenticated;
type Context<S extends AccessStatement> = { db: AccessDb<S>; secret: string };

// Admin and a session under 10 minutes old are required (the first throws 401/403, the second
// becomes a result the screen offers re-auth for); then the target must be a client.
async function guarded<L extends GuardLocals, S extends AccessStatement, T>(
  event: GuardEvent<L>,
  db: AccessDb<S>,
  targetId: string,
  now: number,
  run: (actor: Actor, target: Target) => Promise<Outcome<T>>,
): Promise<Outcome<T>> {
  const actor = requireAdmin(event);
  try {
    requireFreshSession(event, undefined, new Date(now));
  } catch (failure) {
    if (isHttpError(failure) && failure.status === guardErrors.reauthRequired.status) {
      return { ok: false, error: guardErrors.reauthRequired };
    }
    throw failure;
  }
  const profile = await loadTarget(db, targetId);
  return run(actor, {
    id: profile.id,
    email: profile.email,
    banned: profile.banned === 1,
    passkeys: profile.passkeys,
  });
}

const refuse = (error: Failure): { ok: false; error: Failure } => ({ ok: false, error });

/** Failures a new link can hit; a client with a passkey is recovered, not re-invited. */
function linkBlocker(target: Target) {
  if (target.banned) return accessErrors.clientDisabled;
  if (target.passkeys > 0) return accessErrors.alreadyEnrolled;
  return null;
}

export type Issued = Outcome<{ issued: IssuedLink }>;

/** A new activation link; the previous one and its enrollment sessions stop working. */
export function generateLink<L extends GuardLocals, S extends AccessStatement>(
  event: GuardEvent<L>,
  { db, secret }: Context<S>,
  targetId: string,
  now = Date.now(),
): Promise<Issued> {
  return guarded(event, db, targetId, now, async (actor, target) => {
    const blocker = linkBlocker(target);
    if (blocker) return refuse(blocker);
    return { ok: true, issued: await regenerateActivationLink(db, secret, actor, target.id, now) };
  });
}

export function revokeLink<L extends GuardLocals, S extends AccessStatement>(
  event: GuardEvent<L>,
  { db }: Context<S>,
  targetId: string,
  now = Date.now(),
): Promise<Outcome> {
  return guarded(event, db, targetId, now, async (actor, target) => {
    const open = await db
      .prepare(
        `SELECT 1 AS found FROM invitations
         WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
      )
      .bind(target.id, now)
      .first();
    if (open === null) return refuse(accessErrors.noOpenLink);
    await revokeActivationLink(db, actor, target.id, now);
    return { ok: true };
  });
}

const auditInsert = `INSERT INTO audit_log (id, at, actor_id, action, target_user_id, before_json, after_json)`;

/**
 * Deactivates the client (Better Auth's `banUser`, done here as one batch so the audit row and
 * the session deletion cannot be separated): the ban flag, the audit row (written only if this
 * call changed the flag) and every session of the client. The sign-in block itself is the admin
 * plugin's; broker orders are not touched.
 */
export function deactivateClient<L extends GuardLocals, S extends AccessStatement>(
  event: GuardEvent<L>,
  { db }: Context<S>,
  targetId: string,
  now = Date.now(),
): Promise<Outcome<{ sessionsEnded: number }>> {
  return guarded(event, db, targetId, now, async (actor, target) => {
    if (target.banned) return refuse(accessErrors.alreadyDisabled);
    const [updated, , ended] = await db.batch([
      db
        .prepare(
          `UPDATE "user" SET "banned" = 1, "updatedAt" = ? WHERE "id" = ? AND "banned" IS NOT 1`,
        )
        .bind(new Date(now).toISOString(), target.id),
      db
        .prepare(
          `${auditInsert} SELECT ?, ?, ?, ?, ?, json_object('access', 'enabled'),
             json_object('access', 'disabled', 'sessionsEnded', (SELECT COUNT(*) FROM "session" WHERE "userId" = ?))
           WHERE changes() = 1`,
        )
        .bind(crypto.randomUUID(), now, actor.user.id, "client.deactivate", target.id, target.id),
      db.prepare(`DELETE FROM "session" WHERE "userId" = ?`).bind(target.id),
    ]);
    if (updated?.meta.changes !== 1) return refuse(accessErrors.alreadyDisabled);
    return { ok: true, sessionsEnded: ended?.meta.changes ?? 0 };
  });
}

export function reactivateClient<L extends GuardLocals, S extends AccessStatement>(
  event: GuardEvent<L>,
  { db }: Context<S>,
  targetId: string,
  now = Date.now(),
): Promise<Outcome> {
  return guarded(event, db, targetId, now, async (actor, target) => {
    if (!target.banned) return refuse(accessErrors.notDisabled);
    const [updated] = await db.batch([
      db
        .prepare(
          `UPDATE "user" SET "banned" = 0, "banReason" = NULL, "banExpires" = NULL, "updatedAt" = ?
           WHERE "id" = ? AND "banned" = 1`,
        )
        .bind(new Date(now).toISOString(), target.id),
      db
        .prepare(
          `${auditInsert} SELECT ?, ?, ?, ?, ?, json_object('access', 'disabled'),
             json_object('access', 'enabled')
           WHERE changes() = 1`,
        )
        .bind(crypto.randomUUID(), now, actor.user.id, "client.reactivate", target.id),
    ]);
    return updated?.meta.changes === 1 ? { ok: true } : refuse(accessErrors.notDisabled);
  });
}

const SessionForm = Schema.Struct({ sessionId: ClientId });

/** Ends one session of the client; the session must belong to the target, not just exist. */
export function revokeSession<L extends GuardLocals, S extends AccessStatement>(
  event: GuardEvent<L>,
  { db }: Context<S>,
  targetId: string,
  form: unknown,
  now = Date.now(),
): Promise<Outcome> {
  return guarded(event, db, targetId, now, async (actor, target) => {
    const { sessionId } = decode(SessionForm, form);
    const [deleted] = await db.batch([
      db
        .prepare(`DELETE FROM "session" WHERE "id" = ? AND "userId" = ?`)
        .bind(sessionId, target.id),
      db
        .prepare(
          `${auditInsert} SELECT ?, ?, ?, ?, ?, json_object('sessions', 1), json_object('sessions', 0)
           WHERE changes() = 1`,
        )
        .bind(crypto.randomUUID(), now, actor.user.id, "session.revoke", target.id),
    ]);
    return deleted?.meta.changes === 1 ? { ok: true } : refuse(accessErrors.sessionGone);
  });
}

export function revokeAllSessions<L extends GuardLocals, S extends AccessStatement>(
  event: GuardEvent<L>,
  { db }: Context<S>,
  targetId: string,
  now = Date.now(),
): Promise<Outcome<{ sessionsEnded: number }>> {
  return guarded(event, db, targetId, now, async (actor, target) => {
    const [, ended] = await db.batch([
      db
        .prepare(
          `${auditInsert} SELECT ?, ?, ?, ?, ?,
             json_object('sessions', (SELECT COUNT(*) FROM "session" WHERE "userId" = ?)),
             json_object('sessions', 0)
           WHERE EXISTS (SELECT 1 FROM "session" WHERE "userId" = ?)`,
        )
        .bind(
          crypto.randomUUID(),
          now,
          actor.user.id,
          "session.revoke_all",
          target.id,
          target.id,
          target.id,
        ),
      db.prepare(`DELETE FROM "session" WHERE "userId" = ?`).bind(target.id),
    ]);
    const sessionsEnded = ended?.meta.changes ?? 0;
    return sessionsEnded > 0 ? { ok: true, sessionsEnded } : refuse(accessErrors.noSessions);
  });
}

// The admin states they verified the client outside the app; the check is the server's, not the form's.
const RecoveryForm = Schema.Struct({ verified: Schema.Literal("on") });

/**
 * Admin-controlled recovery: ends every session, deletes every passkey and recovery code, closes
 * the open link and issues a new one, in one batch with a single audit row (counts only). The
 * admin never gets a session as the client; the client enrolls through the new link and receives
 * a new set of codes when they finish.
 */
export function recoverClient<L extends GuardLocals, S extends AccessStatement>(
  event: GuardEvent<L>,
  { db, secret }: Context<S>,
  targetId: string,
  form: unknown,
  now = Date.now(),
): Promise<Issued> {
  return guarded(event, db, targetId, now, async (actor, target) => {
    if (target.banned) return refuse(accessErrors.clientDisabled);
    if (
      Schema.decodeUnknownResult(RecoveryForm, { onExcessProperty: "error" })(form)._tag ===
      "Failure"
    ) {
      return refuse(accessErrors.unconfirmed);
    }
    const link = await newInvitation(secret, now);
    await db.batch([
      // First, so the counts are those of the state being replaced.
      db
        .prepare(
          `${auditInsert} VALUES (?, ?, ?, ?, ?,
             json_object('passkeys', (SELECT COUNT(*) FROM "passkey" WHERE "userId" = ?),
               'unusedCodes', (SELECT COUNT(*) FROM recovery_codes WHERE user_id = ? AND used_at IS NULL),
               'sessions', (SELECT COUNT(*) FROM "session" WHERE "userId" = ?)),
             json_object('passkeys', 0, 'unusedCodes', 0, 'sessions', 0, 'linkOpen', json('true')))`,
        )
        .bind(
          crypto.randomUUID(),
          now,
          actor.user.id,
          "client.recover",
          target.id,
          target.id,
          target.id,
          target.id,
        ),
      db
        .prepare(
          `UPDATE invitations SET revoked_at = ?
           WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL`,
        )
        .bind(now, target.id),
      db.prepare(`DELETE FROM "passkey" WHERE "userId" = ?`).bind(target.id),
      db.prepare(`DELETE FROM "session" WHERE "userId" = ?`).bind(target.id),
      db.prepare(`DELETE FROM recovery_codes WHERE user_id = ?`).bind(target.id),
      insertInvitation(db, target.id, link, actor),
    ]);
    return { ok: true, issued: { token: link.token, expiresAt: link.expiresAt } };
  });
}

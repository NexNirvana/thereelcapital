// The admin client detail page's reads and mutations (docs/screens-and-flows.md#admin): access,
// activation link, sessions and controlled recovery (docs/auth-and-security.md#flows). The actor is
// always the session admin from the guards; the only request values are the target client's id
// (from the URL, checked to be a client) and the session id to revoke. Each mutation is one D1
// batch with its audit row, so either everything lands or nothing does. Broker orders are never
// touched: nothing here reaches the engine.
import { error, isHttpError } from "@sveltejs/kit";
import { Schema } from "effect";
import { STOP_PCT_BOUNDS, TRAILING_UNLOCK_PCT_BOUNDS } from "#lib/domain/config.ts";
import { MAX_DAILY_ENTRIES, MAX_OPEN_POSITIONS } from "#lib/domain/guards.ts";
import { validateSizeChange } from "#lib/domain/sizing.ts";
import { validateStopPct, validateTrailingUnlockPct } from "#lib/domain/stop.ts";
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
  ownAccount: {
    status: 403,
    code: "OWN_ACCOUNT",
    message: "No puedes recuperar tu propia cuenta. Pide a otro administrador que lo haga.",
  },
  adminDisabled: {
    status: 409,
    code: "ADMIN_DISABLED",
    message: "El administrador está desactivado y no podría entrar con un enlace nuevo.",
  },
  unconfirmed: {
    status: 400,
    code: "UNCONFIRMED",
    message: "Confirma que verificaste la identidad del cliente fuera de la app.",
  },
} as const;

// Settings refusals (docs/screens-and-flows.md#admin). The bounds in the messages come from the
// domain config, so a decided change there reaches the text too.
export const settingsErrors = {
  sizeInvalid: {
    status: 422,
    code: "SIZE_INVALID",
    message: "SIZE debe ser un monto entero en dólares, mayor que cero.",
  },
  sizeDecrease: { status: 422, code: "SIZE_DECREASE", message: "SIZE solo puede aumentar." },
  stopOutOfBounds: {
    status: 422,
    code: "STOP_PCT_OUT_OF_BOUNDS",
    message: `El stop debe ser un entero entre ${STOP_PCT_BOUNDS.min} y ${STOP_PCT_BOUNDS.max}.`,
  },
  unlockOutOfBounds: {
    status: 422,
    code: "TRAILING_UNLOCK_PCT_OUT_OF_BOUNDS",
    message: `El desbloqueo debe ser un entero entre ${TRAILING_UNLOCK_PCT_BOUNDS.min} y ${TRAILING_UNLOCK_PCT_BOUNDS.max}.`,
  },
  unchanged: { status: 409, code: "SETTINGS_UNCHANGED", message: "No hay cambios que guardar." },
  changedMeanwhile: {
    status: 409,
    code: "SETTINGS_CHANGED",
    message: "La configuración cambió mientras la editabas. Recarga la página.",
  },
  missing: {
    status: 409,
    code: "SETTINGS_MISSING",
    message: "El cliente no tiene configuración.",
  },
} as const;

type Failure =
  | (typeof accessErrors)[keyof typeof accessErrors]
  | (typeof settingsErrors)[keyof typeof settingsErrors]
  | typeof guardErrors.reauthRequired;
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

const SettingsRow = Schema.Struct({
  sizeUsd: Schema.Number,
  stopPct: Schema.Number,
  trailingUnlockPct: Schema.Number,
});
export type ClientSettings = typeof SettingsRow.Type;

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
  /** Null only for a client created without settings, which should not exist. */
  settings: ClientSettings | null;
  /** Lowest SIZE (whole USD) the form accepts: SIZE never goes below the stored one. */
  minSizeUsd: number | null;
  /** Fixed limits, shown read-only (docs/product-spec.md#parameters). */
  limits: { openPositions: number; dailyEntries: number };
  /** Allowed ranges for the form's hints; the server re-checks them with the domain validators. */
  bounds: { stopPct: { min: number; max: number }; unlockPct: { min: number; max: number } };
  sessions: readonly {
    id: string;
    createdAt: number;
    expiresAt: number;
    userAgent: string | null;
    enrollment: boolean;
  }[];
}

type Target = { id: string; email: string; banned: boolean; passkeys: number };

async function loadTarget<S extends AccessStatement>(
  db: AccessDb<S>,
  rawId: string,
  role: "user" | "admin" = "user",
) {
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
  // Client actions never reach an admin (it looks like a missing id); only admin recovery asks
  // for role "admin", and then a client looks like a missing id.
  if (profile === null || profile.role !== role)
    error(404, "Cliente no encontrado.", { code: "NOT_FOUND" });
  return profile;
}

async function loadSettings<S extends AccessStatement>(db: AccessDb<S>, userId: string) {
  const row = await db
    .prepare(
      `SELECT size_usd AS sizeUsd, stop_pct AS stopPct, trailing_unlock_pct AS trailingUnlockPct
       FROM client_settings WHERE user_id = ?`,
    )
    .bind(userId)
    .first();
  return row === null ? null : Schema.decodeUnknownSync(SettingsRow)(row);
}

/** The detail page's data. Hashes, tokens and credential material are never selected. */
export async function getClientDetail<S extends AccessStatement>(
  db: AccessDb<S>,
  rawId: string,
  now = Date.now(),
): Promise<ClientDetail> {
  const profile = await loadTarget(db, rawId);
  const [sessions, links, settings] = await Promise.all([
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
    loadSettings(db, profile.id),
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
    settings,
    minSizeUsd: settings?.sizeUsd ?? null,
    limits: { openPositions: MAX_OPEN_POSITIONS, dailyEntries: MAX_DAILY_ENTRIES },
    bounds: { stopPct: STOP_PCT_BOUNDS, unlockPct: TRAILING_UNLOCK_PCT_BOUNDS },
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
type Context<S extends AccessStatement> = { db: AccessDb<S> };

// Admin and a session under 10 minutes old are required (the first throws 401/403, the second
// becomes a result the screen offers re-auth for); then the target must be a client.
async function guardedAs<L extends GuardLocals, S extends AccessStatement, T>(
  role: "user" | "admin",
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
  const profile = await loadTarget(db, targetId, role);
  return run(actor, {
    id: profile.id,
    email: profile.email,
    banned: profile.banned === 1,
    passkeys: profile.passkeys,
  });
}

const guarded = <L extends GuardLocals, S extends AccessStatement, T>(
  event: GuardEvent<L>,
  db: AccessDb<S>,
  targetId: string,
  now: number,
  run: (actor: Actor, target: Target) => Promise<Outcome<T>>,
) => guardedAs("user", event, db, targetId, now, run);

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
  { db }: Context<S>,
  targetId: string,
  now = Date.now(),
): Promise<Issued> {
  return guarded(event, db, targetId, now, async (actor, target) => {
    const blocker = linkBlocker(target);
    if (blocker) return refuse(blocker);
    return { ok: true, issued: await regenerateActivationLink(db, actor, target.id, now) };
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

type RecoveryAction = "client.recover" | "admin.recover";

// One batch for both targets, with a single audit row (counts only).
async function recoverTarget<S extends AccessStatement>(
  db: AccessDb<S>,
  actor: Actor,
  target: Target,
  action: RecoveryAction,
  now: number,
): Promise<Issued> {
  const link = await newInvitation(now);
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
        action,
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
}

/**
 * Admin-controlled recovery: ends every session, deletes every passkey and recovery code, closes
 * the open link and issues a new one, in one batch with a single audit row (counts only). The
 * admin never gets a session as the client; the client enrolls through the new link and receives
 * a new set of codes when they finish.
 */
export function recoverClient<L extends GuardLocals, S extends AccessStatement>(
  event: GuardEvent<L>,
  { db }: Context<S>,
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
    return recoverTarget(db, actor, target, "client.recover", now);
  });
}

/**
 * Admin-run recovery of ANOTHER admin (D31), same effects as `recoverClient` with the audit
 * action `admin.recover`. Needs a fresh session, refuses the actor's own account (a locked-out
 * admin has no session anyway; a signed-in one must not strip their own passkeys) and a disabled
 * admin. Clients never reach it: `loadTarget` is asked for role "admin".
 */
export function recoverAdmin<L extends GuardLocals, S extends AccessStatement>(
  event: GuardEvent<L>,
  { db }: Context<S>,
  targetId: string,
  form: unknown,
  now = Date.now(),
): Promise<Issued> {
  return guardedAs("admin", event, db, targetId, now, async (actor, target) => {
    if (target.id === actor.user.id) return refuse(accessErrors.ownAccount);
    if (target.banned) return refuse(accessErrors.adminDisabled);
    if (
      Schema.decodeUnknownResult(RecoveryForm, { onExcessProperty: "error" })(form)._tag ===
      "Failure"
    ) {
      return refuse(accessErrors.unconfirmed);
    }
    return recoverTarget(db, actor, target, "admin.recover", now);
  });
}

/** The recovery page's data for another admin: no credential material. */
export async function getAdminSummary<S extends AccessStatement>(db: AccessDb<S>, rawId: string) {
  const { id, email, banned, passkeys, unusedCodes } = await loadTarget(db, rawId, "admin");
  return { id, email, disabled: banned === 1, passkeys, unusedCodes };
}

const AdminRow = Schema.Struct({ id: Schema.String, email: Schema.String });

/** The other admins (never the signed-in one), for the list that leads to their recovery page. */
export async function listOtherAdmins<S extends AccessStatement>(db: AccessDb<S>, selfId: string) {
  const { results } = await db
    .prepare(
      `SELECT "id" AS id, "email" AS email FROM "user"
       WHERE "role" = 'admin' AND "id" != ? ORDER BY "email"`,
    )
    .bind(selfId)
    .all();
  return Schema.decodeUnknownSync(Schema.Array(AdminRow))(results);
}

// Whole numbers typed in the form; anything else becomes NaN and fails the validators.
const MICROS_PER_USD = 1_000_000;
const SettingsForm = Schema.Struct({
  sizeUsd: Schema.String.check(Schema.isMaxLength(12)),
  stopPct: Schema.String.check(Schema.isMaxLength(12)),
  unlockPct: Schema.String.check(Schema.isMaxLength(12)),
});
const wholeNumber = (text: string) => (/^\d+$/.test(text) ? Number(text) : NaN);

/**
 * Saves a client's SIZE, stop % and trailing-unlock %. They apply to new entries and new
 * positions only: open positions keep the values stored on them. SIZE (whole US dollars, the
 * `size_usd` column) may only go up, and the bounds are the domain validators'. The UPDATE
 * matches the values the check ran against, so a concurrent change fails instead of slipping
 * past the increase-only rule; the audit row (before and after) lands in the same batch.
 */
export function updateClientSettings<L extends GuardLocals, S extends AccessStatement>(
  event: GuardEvent<L>,
  { db }: Context<S>,
  targetId: string,
  form: unknown,
  now = Date.now(),
): Promise<Outcome> {
  return guarded(event, db, targetId, now, async (actor, target) => {
    const input = decode(SettingsForm, form);
    const sizeUsd = wholeNumber(input.sizeUsd);
    const stopPct = wholeNumber(input.stopPct);
    const trailingUnlockPct = wholeNumber(input.unlockPct);
    if (!Number.isSafeInteger(sizeUsd) || sizeUsd <= 0) return refuse(settingsErrors.sizeInvalid);
    if (!validateStopPct(stopPct).ok) return refuse(settingsErrors.stopOutOfBounds);
    if (!validateTrailingUnlockPct(trailingUnlockPct).ok) {
      return refuse(settingsErrors.unlockOutOfBounds);
    }
    const before = await loadSettings(db, target.id);
    if (before === null) return refuse(settingsErrors.missing);
    // Equal SIZE is a valid save (only the percentages change); the domain rule decides any change.
    if (sizeUsd !== before.sizeUsd) {
      const micros = sizeUsd * MICROS_PER_USD;
      const currentMicros = before.sizeUsd * MICROS_PER_USD;
      if (!Number.isSafeInteger(micros) || !Number.isSafeInteger(currentMicros)) {
        return refuse(settingsErrors.sizeInvalid);
      }
      if (!validateSizeChange(currentMicros, micros).ok) {
        return refuse(settingsErrors.sizeDecrease);
      }
    }
    const after: ClientSettings = { sizeUsd, stopPct, trailingUnlockPct };
    if (
      after.sizeUsd === before.sizeUsd &&
      after.stopPct === before.stopPct &&
      after.trailingUnlockPct === before.trailingUnlockPct
    ) {
      return refuse(settingsErrors.unchanged);
    }
    const [updated] = await db.batch([
      db
        .prepare(
          `UPDATE client_settings SET size_usd = ?, stop_pct = ?, trailing_unlock_pct = ?, updated_at = ?
           WHERE user_id = ? AND size_usd = ? AND stop_pct = ? AND trailing_unlock_pct = ?`,
        )
        .bind(
          sizeUsd,
          stopPct,
          trailingUnlockPct,
          now,
          target.id,
          before.sizeUsd,
          before.stopPct,
          before.trailingUnlockPct,
        ),
      db
        .prepare(`${auditInsert} SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`)
        .bind(
          crypto.randomUUID(),
          now,
          actor.user.id,
          "client_settings.update",
          target.id,
          JSON.stringify(before),
          JSON.stringify(after),
        ),
    ]);
    return updated?.meta.changes === 1 ? { ok: true } : refuse(settingsErrors.changedMeanwhile);
  });
}

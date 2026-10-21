// Route guards (docs/auth-and-security.md#sessions-and-requests). The user and role come only from
// the session hooks resolved; nothing the client sends decides who they are.
import { error } from "@sveltejs/kit";

// Only the fields the guards read, so tests build real fixtures and App.Locals still fits.
export interface GuardLocals {
  session: { createdAt: Date } | null;
  user: { id: string; role?: string | null; banned?: boolean | null } | null;
}
export interface GuardEvent<L extends GuardLocals = GuardLocals> {
  locals: L;
}

export interface Authenticated<L extends GuardLocals = GuardLocals> {
  session: NonNullable<L["session"]>;
  user: NonNullable<L["user"]>;
}

export const freshSessionMaxAgeMs = 10 * 60 * 1000;

// Messages are the only text that reaches the user; the code is stable for clients and tests.
export const guardErrors = {
  unauthenticated: { status: 401, code: "AUTH_REQUIRED", message: "Inicia sesión para continuar." },
  forbidden: { status: 403, code: "FORBIDDEN", message: "No tienes acceso a este recurso." },
  reauthRequired: {
    status: 401,
    code: "REAUTH_REQUIRED",
    message: "Confirma tu identidad con tu passkey para continuar.",
  },
} as const;

function fail({ status, message, code }: (typeof guardErrors)[keyof typeof guardErrors]): never {
  error(status, message, { code });
}

export function requireUser<L extends GuardLocals>(event: GuardEvent<L>): Authenticated<L> {
  const { session, user } = event.locals;
  if (!session || !user) fail(guardErrors.unauthenticated);
  // banUser deletes sessions, but a stale resolve must not outlive the ban.
  if (user.banned) fail(guardErrors.forbidden);
  return { session, user };
}

export function requireAdmin<L extends GuardLocals>(event: GuardEvent<L>): Authenticated<L> {
  const auth = requireUser(event);
  if (auth.user.role !== "admin") fail(guardErrors.forbidden);
  return auth;
}

/** Better Auth's sensitiveSessionMiddleware doesn't check age, so sensitive actions call this. */
export function requireFreshSession<L extends GuardLocals>(
  event: GuardEvent<L>,
  maxAgeMs = freshSessionMaxAgeMs,
  now = new Date(),
): Authenticated<L> {
  const auth = requireUser(event);
  const ageMs = now.getTime() - auth.session.createdAt.getTime();
  // A createdAt in the future is not fresh, it is wrong.
  if (!(ageMs >= 0 && ageMs < maxAgeMs)) fail(guardErrors.reauthRequired);
  return auth;
}

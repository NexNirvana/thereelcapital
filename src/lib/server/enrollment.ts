// The enrollment-only session (docs/auth-and-security.md#gaps-in-better-auth-defaults): created
// from a recovery code (and, later, an activation link), it may register a passkey and nothing
// else. hooks.server.ts runs `enrollmentGate` on every request, so a new route is closed to it by
// default; only the paths listed here are open. Better Auth itself would accept the session
// cookie on any of its endpoints, which is why the gate also covers /api/auth/*.
import { ENROLLMENT_SESSION_MINUTES } from "#lib/domain/config.ts";

export const enrollmentMaxAgeMs = ENROLLMENT_SESSION_MINUTES * 60 * 1000;

/** Fields of a session the gate needs. `enrollment` is the column added in migration 0004. */
export interface GateSession {
  enrollment?: boolean | null;
  createdAt: Date;
}

// Signing in with a passkey is always possible: it replaces the enrollment cookie with a full
// session, and it is how someone who registered a passkey but never finished gets back in.
const signInPaths = [
  "/api/auth/passkey/generate-authenticate-options",
  "/api/auth/passkey/verify-authentication",
];

// Open to a live enrollment session: the sign-in and recovery pages, the redemption/completion steps, the two passkey
// registration endpoints, the session read/logout pair and the recovery page.
const activePaths = new Set([
  "/acceso",
  "/recuperacion",
  "/api/auth/recovery/redeem",
  "/api/auth/enrollment/complete",
  "/api/auth/passkey/generate-register-options",
  "/api/auth/passkey/verify-registration",
  "/api/auth/get-session",
  "/api/auth/sign-out",
  ...signInPaths,
]);
// An expired one may still start over, and can do nothing else on the auth API.
const expiredAuthPaths = new Set([
  "/api/auth/recovery/redeem",
  "/api/auth/get-session",
  "/api/auth/sign-out",
  ...signInPaths,
]);

export type EnrollmentGate =
  /** Not an enrollment session: the request is handled as usual. */
  | { kind: "none" }
  /** Resolved as signed out; `allowed` says whether this path may run at all. */
  | { kind: "enrollment"; allowed: boolean; expired: boolean };

/**
 * Better Auth refreshes a session's expiry on read, so the 15 minutes are measured from
 * `createdAt`, which never moves.
 */
export function enrollmentGate(
  session: GateSession | null,
  pathname: string,
  now = new Date(),
): EnrollmentGate {
  if (!session?.enrollment) return { kind: "none" };
  const ageMs = now.getTime() - session.createdAt.getTime();
  const expired = !(ageMs >= 0 && ageMs < enrollmentMaxAgeMs);
  const isAuthApi = pathname.startsWith("/api/auth/");
  const allowed = expired
    ? // Expired: signed out for pages (the recovery page restarts); closed on the auth API.
      isAuthApi
      ? expiredAuthPaths.has(pathname)
      : true
    : activePaths.has(pathname) || pathname.startsWith("/_app/");
  return { kind: "enrollment", allowed, expired };
}

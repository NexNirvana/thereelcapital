// Starting and finishing an enrollment-only session (see enrollment.ts for what such a session
// may reach). Shared by recovery (#14) and activation links (#15): each decides who may start
// one; this module only creates it and turns it into a full session.
import type { GenericEndpointContext } from "better-auth";
import { setSessionCookie } from "better-auth/cookies";
import { ENROLLMENT_SESSION_MINUTES } from "#lib/domain/config.ts";

/**
 * Creates the enrollment session, then revokes every other session of the user, so recoveries
 * racing on different codes leave at most one session: each deletes the other's, never its own.
 * (Revoking before creating would let both create after both revoked.)
 */
export async function startEnrollmentSession(
  ctx: GenericEndpointContext,
  userId: string,
  now = new Date(),
): Promise<void> {
  const { internalAdapter, adapter } = ctx.context;
  const user = await internalAdapter.findUserById(userId);
  if (!user) throw new Error("enrollment session for an unknown user");
  const expiresAt = new Date(now.getTime() + ENROLLMENT_SESSION_MINUTES * 60_000);
  // overrideAll: Better Auth would otherwise replace expiresAt with the full session lifetime.
  const session = await internalAdapter.createSession(
    userId,
    false,
    { enrollment: true, expiresAt },
    true,
  );
  await adapter.deleteMany({
    model: "session",
    where: [
      { field: "userId", value: userId },
      { field: "token", operator: "ne", value: session.token },
    ],
  });
  await setSessionCookie(ctx, { session, user }, false, {
    maxAge: ENROLLMENT_SESSION_MINUTES * 60,
  });
}

/** Ends every session of the user and signs them in with a normal one. */
export async function startFullSession(ctx: GenericEndpointContext, userId: string): Promise<void> {
  const { internalAdapter } = ctx.context;
  const user = await internalAdapter.findUserById(userId);
  if (!user) throw new Error("session for an unknown user");
  await internalAdapter.deleteUserSessions(userId);
  const session = await internalAdapter.createSession(userId);
  await setSessionCookie(ctx, { session, user });
}

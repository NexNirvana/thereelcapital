// Audit rows for the authentication flows, which have no admin actor (docs/auth-and-security.md#audit).
// None of them stores a secret, a code or a token: a rejected attempt records why it failed and a
// keyed hash of the caller's IP (enough to see one source hammering the endpoints, not to read it).
import { getIP } from "@better-auth/core/utils/ip";
import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import type { BetterAuthPlugin, GenericEndpointContext } from "better-auth";
import { audit, type AuditDb, type AuditEntry } from "./audit.ts";
import { hashToken } from "./token-hash.ts";

// There is no signed-in user behind a rejected redemption.
const anonymous = { user: { id: "anonymous" } };

type Db = AuditDb<{ run(): Promise<unknown> }>;

export type RejectedAttempt = "recovery.redeem_failed" | "activation.redeem_failed";

export async function auditRejectedAttempt(
  db: Db,
  secret: string,
  ctx: GenericEndpointContext,
  action: RejectedAttempt,
  reason: string,
): Promise<void> {
  const ip = ctx.request ? getIP(ctx.request, ctx.context.options) : null;
  const ipHash = ip === null ? null : (await hashToken("audit-ip", ip, secret)).slice(0, 16);
  await audit(db, {
    actor: anonymous,
    action,
    targetUserId: null,
    before: null,
    after: { reason, ipHash },
  });
}

/**
 * Audits a session the request just started. If the write fails, the session is deleted before
 * the error propagates: the error response may not carry the cookie, and a session with no audit
 * row must not outlive the request.
 */
export async function auditStartedSession(
  db: Db,
  ctx: Pick<GenericEndpointContext, "context">,
  entry: AuditEntry,
): Promise<void> {
  try {
    await audit(db, entry);
  } catch (failure) {
    const started = ctx.context.newSession;
    if (started) await ctx.context.internalAdapter.deleteSession(started.session.token);
    throw failure;
  }
}

/** `auth.sign_in` after a passkey ceremony created a session, `auth.sign_out` before it ends one. */
export function sessionAuditPlugin(db: Db) {
  return {
    id: "session-audit",
    hooks: {
      before: [
        {
          matcher: (context) => context.path === "/sign-out",
          handler: createAuthMiddleware(async (ctx) => {
            const current = await getSessionFromCtx(ctx);
            if (!current) return;
            await audit(db, {
              actor: { user: current.user },
              action: "auth.sign_out",
              targetUserId: current.user.id,
              before: null,
              after: null,
            });
          }),
        },
      ],
      after: [
        {
          matcher: (context) => context.path === "/passkey/verify-authentication",
          handler: createAuthMiddleware(async (ctx) => {
            const created = ctx.context.newSession;
            if (!created) return;
            await auditStartedSession(db, ctx, {
              actor: { user: created.user },
              action: "auth.sign_in",
              targetUserId: created.user.id,
              before: null,
              after: { method: "passkey" },
            });
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}

// Opening an activation link as a Better Auth plugin, for the same reasons as the recovery
// plugin: it needs the session internals and cookie handling, and the router applies its rate
// limit. Finishing is shared with recovery (`/enrollment/complete`).
// docs/auth-and-security.md#flows
import { APIError, createAuthEndpoint } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth";
import { Schema } from "effect";
import { ACTIVATION_REDEEM_RATE_LIMIT } from "#lib/domain/config.ts";
import { activationErrors, recoveryErrors } from "#lib/auth-messages.ts";
import { findOpenInvitation, startActivationSession } from "./activation.ts";
import { auditRejectedAttempt, auditStartedSession } from "./auth-audit.ts";

// A token is 43 characters; the cap only bounds what gets hashed. No unknown fields.
const RedeemBody = Schema.Struct({ token: Schema.String.check(Schema.isMaxLength(64)) });

export function activationPlugin(db: D1Database, secret: string) {
  return {
    id: "activation",
    rateLimit: [
      {
        pathMatcher: (path: string) => path === "/activation/redeem",
        window: ACTIVATION_REDEEM_RATE_LIMIT.windowSeconds,
        max: ACTIVATION_REDEEM_RATE_LIMIT.max,
      },
    ],
    endpoints: {
      /**
       * Activation token -> enrollment session tied to its link. The link is not spent here (a
       * link preview or a failed passkey must not burn it); the passkey registration spends it.
       * Opening the link again replaces the earlier enrollment session.
       */
      redeemActivationLink: createAuthEndpoint(
        "/activation/redeem",
        { method: "POST" },
        async (ctx) => {
          const body = Schema.decodeUnknownResult(RedeemBody, { onExcessProperty: "error" })(
            ctx.body,
          );
          if (body._tag === "Failure")
            throw APIError.from("BAD_REQUEST", recoveryErrors.invalidInput);
          const open = await findOpenInvitation(db, body.success.token, secret);
          if (open === null) {
            await auditRejectedAttempt(db, secret, ctx, "activation.redeem_failed", "invalid_link");
            throw APIError.from("UNAUTHORIZED", activationErrors.invalidLink);
          }
          // False when the link closed since the lookup (the client finished, or it was revoked).
          if (!(await startActivationSession(ctx, db, open))) {
            await auditRejectedAttempt(db, secret, ctx, "activation.redeem_failed", "link_closed");
            throw APIError.from("UNAUTHORIZED", activationErrors.invalidLink);
          }
          // After the session exists, so a row means a session started, never an attempt that failed.
          await auditStartedSession(db, ctx, {
            actor: { user: { id: open.userId } },
            action: "activation.redeem",
            targetUserId: open.userId,
            before: null,
            after: null,
          });
          ctx.setHeader("cache-control", "no-store");
          return ctx.json({ enrollment: true });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}

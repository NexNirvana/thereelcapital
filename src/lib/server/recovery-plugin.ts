// Recovery endpoints as a Better Auth plugin: they need its session internals and cookie
// handling, and its router applies the plugin's rate limit (a direct auth.api call would not).
// docs/auth-and-security.md#flows
import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth";
import { Schema } from "effect";
import { RECOVERY_REDEEM_RATE_LIMIT } from "#lib/domain/config.ts";
import { recoveryErrors } from "#lib/auth-messages.ts";
import { enrollmentMaxAgeMs } from "./enrollment.ts";
import { startEnrollmentSession, startFullSession } from "./enrollment-session.ts";
import { redeemRecoveryCode, releaseRecoveryCode, replaceRecoveryCodes } from "./recovery-codes.ts";

// A code is 25 symbols plus dashes; the cap only bounds what gets hashed. No unknown fields.
const RedeemBody = Schema.Struct({ code: Schema.String.check(Schema.isMaxLength(64)) });

export function recoveryPlugin(db: D1Database, secret: string) {
  return {
    id: "recovery",
    rateLimit: [
      {
        pathMatcher: (path: string) => path === "/recovery/redeem",
        window: RECOVERY_REDEEM_RATE_LIMIT.windowSeconds,
        max: RECOVERY_REDEEM_RATE_LIMIT.max,
      },
    ],
    endpoints: {
      /**
       * Recovery code -> every session and passkey deleted (one batch with spending the code) ->
       * enrollment-only session.
       */
      redeemRecoveryCode: createAuthEndpoint(
        "/recovery/redeem",
        { method: "POST" },
        async (ctx) => {
          const body = Schema.decodeUnknownResult(RedeemBody, { onExcessProperty: "error" })(
            ctx.body,
          );
          if (body._tag === "Failure")
            throw APIError.from("BAD_REQUEST", recoveryErrors.invalidInput);
          const { code } = body.success;
          const spentAt = Date.now();
          const userId = await redeemRecoveryCode(db, code, secret, spentAt);
          if (userId === null) throw APIError.from("UNAUTHORIZED", recoveryErrors.invalidCode);
          try {
            await startEnrollmentSession(ctx, userId);
          } catch (failure) {
            // No access was granted, so give the code back: the client must not lose a code (their
            // last one, perhaps) to a failed write. The old passkeys and sessions stay deleted.
            await releaseRecoveryCode(db, code, secret, spentAt);
            throw failure;
          }
          return ctx.json({ enrollment: true });
        },
      ),

      /**
       * Enrollment session with a passkey registered during it -> full session and a new set of
       * recovery codes, shown once. The enrollment session is claimed with a DELETE that must
       * change one row, so a repeated or concurrent call cannot issue two sets.
       */
      completeEnrollment: createAuthEndpoint(
        "/enrollment/complete",
        { method: "POST" },
        async (ctx) => {
          const current = await getSessionFromCtx(ctx);
          if (!current?.session.enrollment)
            throw APIError.from("UNAUTHORIZED", recoveryErrors.enrollmentRequired);
          const { session, user } = current;
          const age = Date.now() - session.createdAt.getTime();
          if (!(age >= 0 && age < enrollmentMaxAgeMs)) {
            throw APIError.from("UNAUTHORIZED", recoveryErrors.enrollmentRequired);
          }
          const passkeys = await ctx.context.adapter.findMany<{ createdAt?: Date | null }>({
            model: "passkey",
            where: [{ field: "userId", value: user.id }],
          });
          if (
            !passkeys.some((passkey) => passkey.createdAt && passkey.createdAt >= session.createdAt)
          ) {
            throw APIError.from("FORBIDDEN", recoveryErrors.passkeyRequired);
          }
          const claimed = await db
            .prepare('DELETE FROM "session" WHERE "token" = ? AND "enrollment" = 1')
            .bind(session.token)
            .run();
          if (claimed.meta.changes !== 1) {
            throw APIError.from("UNAUTHORIZED", recoveryErrors.enrollmentRequired);
          }
          // The session comes before the codes: if it fails, the old codes are still intact; if the
          // replacement fails, the client is signed in and can regenerate from settings.
          await startFullSession(ctx, user.id);
          const codes = await replaceRecoveryCodes(db, secret, {
            actor: { user },
            userId: user.id,
            action: "recovery_codes.issue",
          });
          ctx.setHeader("cache-control", "no-store");
          return ctx.json({ codes });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}

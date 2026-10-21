// Which Better Auth endpoints answer over HTTP at all (docs/auth-and-security.md#endpoint-allowlist).
// An allowlist, not a deny list: the admin plugin alone has a dozen endpoints that change roles,
// bans and sessions with no fresh-session check and no audit row, and a plugin update adding
// another must not open it. The app reaches the admin API only in-process (`auth.api.createUser`),
// which never passes through the router.
import { normalizePathname } from "@better-auth/core/utils/url";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { isFreshSession } from "./guards.ts";

export const allowedAuthPaths: ReadonlySet<string> = new Set([
  "/get-session",
  "/sign-out",
  "/passkey/generate-authenticate-options",
  "/passkey/verify-authentication",
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
  "/passkey/list-user-passkeys",
  "/passkey/delete-passkey",
  "/passkey/update-passkey",
  "/recovery/redeem",
  "/activation/redeem",
  "/enrollment/complete",
]);

// Passkey changes from a full session need a fresh one (docs/auth-and-security.md#sessions-and-requests);
// Better Auth's sensitiveSessionMiddleware checks no age. An enrollment session (recovery or
// activation) keeps registration, which is all it can reach, and is not asked to re-authenticate.
const freshSessionPaths = new Set([
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
  "/passkey/delete-passkey",
  "/passkey/update-passkey",
]);

export const reauthRequired = {
  code: "REAUTH_REQUIRED",
  message: "Confirma tu identidad con tu passkey para continuar.",
} as const;

export function endpointPolicyPlugin(basePath = "/api/auth") {
  return {
    id: "endpoint-policy",
    hooks: {
      before: [
        {
          matcher: (context) => context.path !== undefined && freshSessionPaths.has(context.path),
          handler: createAuthMiddleware(async (ctx) => {
            const current = await getSessionFromCtx(ctx);
            // No session: the endpoint's own middleware answers 401.
            if (!current || current.session.enrollment) return;
            if (!isFreshSession(current.session.createdAt))
              throw APIError.from("UNAUTHORIZED", reauthRequired);
          }),
        },
      ],
    },
    async onRequest(request) {
      if (allowedAuthPaths.has(normalizePathname(request.url, basePath))) return;
      return { response: new Response("Not Found", { status: 404 }) };
    },
  } satisfies BetterAuthPlugin;
}

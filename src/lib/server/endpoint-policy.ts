// Which Better Auth endpoints answer over HTTP at all (docs/auth-and-security.md#endpoint-allowlist).
// An allowlist, not a deny list: the admin plugin alone has a dozen endpoints that change roles,
// bans and sessions with no fresh-session check and no audit row, and a plugin update adding
// another must not open it. The app reaches the admin API only in-process (`auth.api.createUser`),
// which never passes through the router.
import { normalizePathname } from "@better-auth/core/utils/url";
import type { BetterAuthPlugin } from "better-auth";

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

export function endpointPolicyPlugin(basePath = "/api/auth") {
  return {
    id: "endpoint-policy",
    async onRequest(request) {
      if (allowedAuthPaths.has(normalizePathname(request.url, basePath))) return;
      return { response: new Response("Not Found", { status: 404 }) };
    },
  } satisfies BetterAuthPlugin;
}

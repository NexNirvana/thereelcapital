import { passkey } from "@better-auth/passkey";
import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { admin } from "better-auth/plugins";
import type { DatabaseSync } from "node:sqlite";
import { bannedUserMessage, requireUserVerified } from "./passkey-policy.ts";
import { activationPlugin } from "./activation-plugin.ts";
import { claimActivationOnRegistration } from "./activation.ts";
import { endpointPolicyPlugin } from "./endpoint-policy.ts";
import { SESSION_COOKIE_CACHE_SECONDS } from "#lib/domain/config.ts";
import { sessionCachePolicyPlugin } from "./session-cache.ts";
import { sessionAuditPlugin } from "./auth-audit.ts";
import { recoveryPlugin } from "./recovery-plugin.ts";

export interface AuthEnv {
  // D1 in the Workers; the schema CLI passes a SQLite database.
  DB: D1Database | DatabaseSync;
  BETTER_AUTH_SECRET: string;
  // Public origin of the app: https://thereelcapital.com in production, the local origin in dev.
  // The single source of baseURL, passkey rpID and passkey origin.
  APP_ORIGIN: string;
}

// docs/auth-and-security.md#configuration. `trailingPlugins` is where sveltekitCookies goes:
// it must be the last plugin, and it needs the request event, which only hooks have.
export type Auth = ReturnType<typeof createAuth>;

export function createAuth(
  env: AuthEnv,
  { trailingPlugins = [] }: { trailingPlugins?: BetterAuthPlugin[] } = {},
) {
  const { origin, hostname } = new URL(env.APP_ORIGIN);
  return betterAuth({
    appName: "Reel Capital",
    baseURL: origin,
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    // No sign-up, no password, no email: the admin creates users and hands over an activation link.
    emailAndPassword: { enabled: false },
    // Defense in depth for the two worst admin endpoints; the allowlist plugin below closes the rest.
    disabledPaths: ["/admin/impersonate-user", "/admin/set-user-password"],
    // A session created from a recovery code (or activation link) that may only register a
    // passkey; src/lib/server/enrollment.ts is its single enforcement point.
    session: {
      // Reads skip D1 for SESSION_COOKIE_CACHE_SECONDS (D43); session-cache.ts keeps mutations off it.
      cookieCache: { enabled: true, maxAge: SESSION_COOKIE_CACHE_SECONDS },
      additionalFields: {
        enrollment: { type: "boolean", defaultValue: false, input: false },
        // The activation link the enrollment session came from (migration 0006).
        invitationId: { type: "string", required: false, input: false },
      },
    },
    // In-memory limits are per isolate on Workers, so the counters live in D1.
    rateLimit: { enabled: true, storage: "database" },
    advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
    plugins: [
      sessionCachePolicyPlugin(),
      endpointPolicyPlugin(),
      admin({ adminRoles: ["admin"], bannedUserMessage }),
      passkey({
        rpID: hostname,
        rpName: "Reel Capital",
        origin,
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        // The plugin verifies with requireUserVerification: false, so the flag is checked here
        // (docs/auth-and-security.md#gaps-in-better-auth-defaults). A throw aborts before any
        // passkey is stored or any session is created.
        registration: {
          afterVerification: async ({ verification, ctx }) => {
            requireUserVerified(verification.registrationInfo?.userVerified);
            // The first passkey spends the activation link, in this same request and before the
            // passkey is stored (docs/auth-and-security.md#flows). Schema CLI has no D1: skip.
            if ("batch" in env.DB) await claimActivationOnRegistration(env.DB, ctx);
          },
        },
        authentication: {
          afterVerification: ({ verification }) =>
            requireUserVerified(verification.authenticationInfo.userVerified),
        },
      }),
      // Recovery, activation and the audit trail write raw SQL, so they need D1; the schema CLI (SQLite) only reads options.
      ...("batch" in env.DB
        ? [
            sessionAuditPlugin(env.DB),
            recoveryPlugin(env.DB, env.BETTER_AUTH_SECRET),
            activationPlugin(env.DB, env.BETTER_AUTH_SECRET),
          ]
        : []),
      ...trailingPlugins,
    ],
  });
}

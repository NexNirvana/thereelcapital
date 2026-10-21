import { passkey } from "@better-auth/passkey";
import { betterAuth, type BetterAuthOptions, type BetterAuthPlugin } from "better-auth";
import { admin } from "better-auth/plugins";
import { bannedUserMessage, requireUserVerified } from "./passkey-policy.ts";

export interface AuthEnv {
  // D1 in the Workers; the schema CLI passes a SQLite database.
  DB: NonNullable<BetterAuthOptions["database"]>;
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
    // The password and impersonation endpoints must never be reachable.
    disabledPaths: ["/admin/impersonate-user", "/admin/set-user-password"],
    // In-memory limits are per isolate on Workers, so the counters live in D1.
    rateLimit: { enabled: true, storage: "database" },
    advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
    plugins: [
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
          afterVerification: ({ verification }) =>
            requireUserVerified(verification.registrationInfo?.userVerified),
        },
        authentication: {
          afterVerification: ({ verification }) =>
            requireUserVerified(verification.authenticationInfo.userVerified),
        },
      }),
      ...trailingPlugins,
    ],
  });
}

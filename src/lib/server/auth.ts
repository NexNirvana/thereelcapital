import { passkey } from "@better-auth/passkey";
import { betterAuth, type BetterAuthOptions, type BetterAuthPlugin } from "better-auth";
import { admin } from "better-auth/plugins";

export interface AuthEnv {
  // D1 in the Workers; the schema CLI passes a SQLite database.
  DB: NonNullable<BetterAuthOptions["database"]>;
  BETTER_AUTH_SECRET: string;
}

// docs/auth-and-security.md#configuration. `trailingPlugins` is where sveltekitCookies goes:
// it must be the last plugin, and it needs the request event, which only hooks have.
export type Auth = ReturnType<typeof createAuth>;

export function createAuth(
  env: AuthEnv,
  { baseURL, trailingPlugins = [] }: { baseURL: string; trailingPlugins?: BetterAuthPlugin[] },
) {
  return betterAuth({
    appName: "Reel Capital",
    baseURL,
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
      admin({ adminRoles: ["admin"] }),
      passkey({
        // The deployed domain in production, localhost under `wrangler dev`.
        rpID: new URL(baseURL).hostname,
        rpName: "Reel Capital",
        origin: new URL(baseURL).origin,
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
      }),
      ...trailingPlugins,
    ],
  });
}

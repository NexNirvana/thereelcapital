// Bindings are read with `import { env } from 'cloudflare:workers'`, typed by worker-configuration.d.ts.
import type { Auth } from "#lib/server/auth.ts";

type AuthSession = Auth["$Infer"]["Session"];

declare global {
  namespace App {
    // `code` is the stable identifier clients and tests rely on; message is Spanish.
    interface Error {
      message: string;
      code?: string;
    }
    interface Locals {
      // The per-isolate Better Auth instance of this request (shared-auth.ts): server code that needs
      // Better Auth uses it instead of building another one.
      auth: Auth;
      session: AuthSession["session"] | null;
      user: AuthSession["user"] | null;
      // Set instead of session/user while the request carries a live enrollment-only session.
      // `invitationId` is the activation link it came from; null for recovery.
      enrollment: { userId: string; invitationId: string | null } | null;
    }
  }
}

export {};

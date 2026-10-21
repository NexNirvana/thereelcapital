// Bindings are read with `import { env } from 'cloudflare:workers'`, typed by worker-configuration.d.ts.
import type { Auth } from "#lib/server/auth.ts";

type AuthSession = Auth["$Infer"]["Session"];

declare global {
  namespace App {
    interface Locals {
      session: AuthSession["session"] | null;
      user: AuthSession["user"] | null;
    }
  }
}

export {};

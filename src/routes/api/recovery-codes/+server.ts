import { env } from "cloudflare:workers";
import type { RequestHandler } from "./$types";
import { regenerateRecoveryCodes } from "#lib/server/recovery-regenerate.ts";

// The settings screen (a later milestone) calls this; it needs a session under 10 minutes old.
export const POST: RequestHandler = (event) =>
  regenerateRecoveryCodes(event, env.DB, env.BETTER_AUTH_SECRET);

import { env } from "cloudflare:workers";
import { handleSeed } from "#lib/server/test-seed.ts";
import type { RequestHandler } from "./$types";

// Test-only (ENVIRONMENT development/test); production answers 404. See test-seed.ts.
export const POST: RequestHandler = async ({ request }) =>
  handleSeed(
    { environment: env.ENVIRONMENT, db: env.DB, engine: env.ENGINE },
    await request.json().catch(() => null),
  );

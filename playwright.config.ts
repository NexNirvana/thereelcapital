import { defineConfig } from "@playwright/test";
import { inspectorPort, origin, stateDir, webPort } from "./tests/e2e/ports.ts";

export default defineConfig({
  testDir: "./tests/e2e",
  // On CI each shard writes a blob report; the `e2e` job merges them into the HTML report.
  reporter: process.env.CI ? [["list"], ["blob"]] : "list",
  // The specs share one local database, so they run one at a time.
  workers: 1,
  // The slowest test takes about 25 s. A wait on the engine may last up to SETTLE_MS
  // (tests/e2e/support.ts), so allow two of them; a hang then fails in 90 s, not 5 minutes.
  timeout: 90_000,
  use: { baseURL: origin },
  // Always builds and serves a fresh copy of both Workers on this run's own ports and state
  // directory (tests/e2e/ports.ts), so tests never meet a stale `bun run dev` on 8787 or another run.
  webServer: {
    // The secret is a throwaway test value, not a credential; CI has no .dev.vars. The engine's
    // test vars (key, local-sim broker, pinned clock) come from tests/e2e/engine.env.
    command: [
      "vite build",
      `wrangler d1 migrations apply DB --local --persist-to ${stateDir}`,
      `wrangler dev -c wrangler.jsonc -c engine/wrangler.jsonc --port ${webPort} --inspector-port ${inspectorPort} --local-upstream localhost:${webPort} --persist-to ${stateDir} --env-file tests/e2e/engine.env --var BETTER_AUTH_SECRET:e2e-only-secret-0123456789-0123456789 --var APP_ORIGIN:${origin}`,
    ]
      .map((step) => `bun run ${step}`)
      .join(" && "),
    url: origin,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  // On CI each shard writes a blob report; the `e2e` job merges them into the HTML report.
  reporter: process.env.CI ? [["list"], ["blob"]] : "list",
  // The specs seed the one local D1 file through the wrangler CLI while the dev server uses it;
  // parallel workers contend for its lock (SQLITE_BUSY).
  workers: 1,
  use: { baseURL: "http://localhost:8790" },
  // Always builds and serves a fresh copy of both Workers on its own port, so
  // tests never run against a stale `bun run dev` server on 8787.
  webServer: {
    // The secret is a throwaway test value, not a credential; CI has no .dev.vars. The engine's
    // test vars (key, local-sim broker, pinned clock) come from tests/e2e/engine.env.
    command:
      "bun run dev:build && bun run wrangler dev -c wrangler.jsonc -c engine/wrangler.jsonc --port 8790 --local-upstream localhost:8790 --env-file tests/e2e/engine.env --var BETTER_AUTH_SECRET:e2e-only-secret-0123456789-0123456789 --var APP_ORIGIN:http://localhost:8790",
    url: "http://localhost:8790",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  // On CI, also write the HTML report that the workflow uploads when a test fails.
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  // The specs seed the one local D1 file through the wrangler CLI while the dev server uses it;
  // parallel workers contend for its lock (SQLITE_BUSY).
  workers: 1,
  use: { baseURL: "http://localhost:8790" },
  // Always builds and serves a fresh copy of both Workers on its own port, so
  // tests never run against a stale `bun run dev` server on 8787.
  webServer: {
    // The secret and key are throwaway test values, not credentials; CI has no .dev.vars.
    command:
      "[ -f engine/.dev.vars ] || printf 'CREDENTIALS_KEY=BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=\\n' > engine/.dev.vars && bun run dev:build && bun run wrangler dev -c wrangler.jsonc -c engine/wrangler.jsonc --port 8790 --local-upstream localhost:8790 --var BETTER_AUTH_SECRET:e2e-only-secret-0123456789-0123456789 --var APP_ORIGIN:http://localhost:8790",
    url: "http://localhost:8790",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  // On CI, also write the HTML report that the workflow uploads when a test fails.
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: "http://localhost:8790" },
  // Always builds and serves a fresh copy of both Workers on its own port, so
  // tests never run against a stale `bun run dev` server on 8787.
  webServer: {
    // The secret is a throwaway test value, not a credential; CI has no .dev.vars.
    command:
      "bun run dev --port 8790 --var BETTER_AUTH_SECRET:e2e-only-secret-0123456789-0123456789 --var APP_ORIGIN:http://localhost:8790",
    url: "http://localhost:8790",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  use: { baseURL: "http://localhost:8790" },
  // Always builds and serves a fresh copy of both Workers on its own port, so
  // tests never run against a stale `bun run dev` server on 8787.
  webServer: {
    command: "bun run dev --port 8790",
    url: "http://localhost:8790",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(import.meta.dirname, "../migrations"));
      return {
        wrangler: { configPath: "./engine/wrangler.jsonc" },
        // Test-only binding read by apply-migrations.ts.
        // CREDENTIALS_KEY is a throwaway test value (base64 of 32 bytes), not a credential.
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // The only place the local simulation is switched on (broker/select.ts).
            BROKER: "local-sim",
            ENVIRONMENT: "test",
            CREDENTIALS_KEY: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
          },
        },
      };
    }),
  ],
  test: {
    // Every file runs its own workerd in parallel and each test makes several Durable Object and D1
    // round trips. A busy machine stretches a 0.3 s test past the 5 s default (a failure that moves
    // between tests from run to run), so the budget is for a loaded run, not a quiet one.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // market-calendar is CommonJS and requires luxon; the pool's module shim loses luxon's exports
    // unless both are pre-bundled.
    deps: { optimizer: { ssr: { enabled: true, include: ["market-calendar", "luxon"] } } },
    include: ["engine/test/**/*.test.ts"],
    setupFiles: ["./engine/test/apply-migrations.ts"],
  },
});

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
            CREDENTIALS_KEY: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
          },
        },
      };
    }),
  ],
  test: {
    include: ["engine/test/**/*.test.ts"],
    setupFiles: ["./engine/test/apply-migrations.ts"],
  },
});

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
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      };
    }),
  ],
  test: {
    include: ["engine/test/**/*.test.ts"],
    setupFiles: ["./engine/test/apply-migrations.ts"],
  },
});

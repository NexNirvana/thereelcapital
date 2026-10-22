import { defineConfig } from "@playwright/test";

// Used only by `playwright merge-reports --config`. Shards may run on runners with different
// workspace paths, and the merge refuses blob reports recorded under different test directories
// unless the config names one (https://playwright.dev/docs/test-sharding#merge-reports-cli).
export default defineConfig({
  testDir: "./tests/e2e",
  reporter: "html",
});

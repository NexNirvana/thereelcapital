/// <reference types="@cloudflare/vitest-plugin/types" />

// Test-only binding injected by vitest.config.ts.
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}

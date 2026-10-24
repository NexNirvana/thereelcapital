// Test-only: sqliteD1 plus a log of every statement prepared, to count D1 work per action.
import type { AuthEnv } from "./auth.ts";
import { sqliteD1 } from "./sqlite-d1.test.ts";

export const SECRET = "s".repeat(40);
export const APP_ORIGIN = "https://thereelcapital.com";

export function countingD1() {
  const base = sqliteD1();
  const statements: string[] = [];
  const DB = {
    prepare: (sql: string) => {
      statements.push(sql);
      const statement = base.prepare(sql);
      return {
        bind: (...bindings: never[]) => {
          const bound = statement.bind(...bindings);
          return {
            ...bound,
            all: async () => ({ results: (await bound.all()).results, meta: { changes: 0 } }),
          };
        },
      };
    },
    batch: base.batch,
    exec: async () => ({}),
  };
  return {
    sqlite: base.sqlite,
    statements,
    env: { DB, BETTER_AUTH_SECRET: SECRET, APP_ORIGIN } as unknown as AuthEnv,
  };
}

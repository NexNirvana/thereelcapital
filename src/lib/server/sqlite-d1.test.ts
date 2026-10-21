// Test-only: the real migrations on bun:sqlite behind the slice of the D1 API the server code
// uses, so SQL guards (single-use UPDATE, batches) are exercised against SQLite, not a mock.
import { expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";

type Bindings = SQLQueryBindings[];

export function sqliteD1() {
  const sqlite = new Database(":memory:");
  const dir = new URL("../../../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) {
    sqlite.run(readFileSync(new URL(file, dir), "utf8"));
  }
  const prepare = (sql: string) => ({
    bind: (...bindings: Bindings) => {
      return {
        run: async () => ({ meta: { changes: sqlite.query(sql).run(...bindings).changes } }),
        first: async (): Promise<Record<string, unknown> | null> =>
          sqlite.query<Record<string, unknown>, Bindings>(sql).get(...bindings),
        all: async () => ({ results: sqlite.query(sql).all(...bindings) }),
        sql,
        bindings,
      };
    },
  });
  type Statement = ReturnType<ReturnType<typeof prepare>["bind"]>;
  return {
    sqlite,
    prepare,
    batch: async (statements: Statement[]) => {
      return sqlite.transaction(() =>
        statements.map((statement) => ({
          meta: { changes: sqlite.query(statement.sql).run(...statement.bindings).changes },
        })),
      )();
    },
  };
}

test("a failing statement rolls the whole batch back", async () => {
  const db = sqliteD1();
  const insert = db.prepare("INSERT INTO recovery_codes (id, user_id, code_hash) VALUES (?, ?, ?)");
  await expect(
    db.batch([insert.bind("a", "ghost", "h1"), db.prepare("SELECT * FROM missing").bind()]),
  ).rejects.toThrow();
  expect(db.sqlite.query("SELECT COUNT(*) AS n FROM recovery_codes").get()).toEqual({ n: 0 });
});

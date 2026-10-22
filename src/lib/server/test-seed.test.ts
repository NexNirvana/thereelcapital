import { describe, expect, test } from "bun:test";
import { handleSeed, type SeedDeps } from "./test-seed.ts";
import { sqliteD1 } from "./sqlite-d1.test.ts";

const seeded: unknown[] = [];
const engine: SeedDeps["engine"] = {
  getByName: () => ({
    seedForTest: async (statements) => {
      seeded.push(statements);
      return { ok: true };
    },
  }),
};
const d1Body = { target: "d1", statements: ["SELECT 1 AS n"] };

describe("test seeding route", () => {
  test("answers 404 in production, when unset and for look-alike values", async () => {
    for (const environment of ["production", undefined, "", "Test"]) {
      const db = sqliteD1();
      await expect(handleSeed({ environment, db, engine }, d1Body)).rejects.toMatchObject({
        status: 404,
      });
      await expect(
        handleSeed(
          { environment, db, engine },
          { target: "engine", clientId: "c", statements: [] },
        ),
      ).rejects.toMatchObject({ status: 404 });
    }
    expect(seeded).toEqual([]);
  });

  test("runs a multi-statement D1 seed in one batch in test", async () => {
    const db = sqliteD1();
    const response = await handleSeed(
      { environment: "test", db, engine },
      {
        target: "d1",
        statements: [
          `INSERT INTO "user" ("id","name","email","emailVerified","createdAt","updatedAt")
           VALUES ('u','n','u@example.com',0,'2026-01-01','2026-01-01');
          `.replace(/\s+/g, " "),
          `SELECT COUNT(*) AS n FROM "user"`,
        ],
      },
    );
    expect(await response.json()).toEqual({ results: [{ n: 1 }] });
  });

  test("hands engine statements to the client's own object", async () => {
    const response = await handleSeed(
      { environment: "development", db: sqliteD1(), engine },
      { target: "engine", clientId: "c1", statements: [{ sql: "DELETE FROM x", params: [] }] },
    );
    expect(response.status).toBe(200);
    expect(seeded).toEqual([[{ sql: "DELETE FROM x", params: [] }]]);
  });

  test("rejects malformed bodies", async () => {
    await expect(
      handleSeed({ environment: "test", db: sqliteD1(), engine }, { target: "d1" }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

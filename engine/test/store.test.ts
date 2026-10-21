import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/schema.ts";

const TABLES = [
  "broker_accounts",
  "entry_counters",
  "events",
  "intents",
  "oauth_attempts",
  "positions",
  "scaleout_steps",
];

function tableNames(sql: SqlStorage): string[] {
  return sql
    .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .toArray()
    .map((row) => row.name);
}

describe("ClientCoordinator store", () => {
  it("creates the schema on first access", async () => {
    const stub = env.COORDINATOR.getByName("fresh-client");
    await stub.ping();

    const names = await runInDurableObject(stub, (_i, state) => tableNames(state.storage.sql));
    expect(names).toEqual(expect.arrayContaining(TABLES));
  });

  it("keeps a mode column on every table", async () => {
    const stub = env.COORDINATOR.getByName("mode-columns");
    await stub.ping();

    const missing = await runInDurableObject(stub, (_i, state) =>
      TABLES.filter(
        (table) =>
          !state.storage.sql
            .exec<{ name: string }>(`PRAGMA table_info(${table})`)
            .toArray()
            .some((column) => column.name === "mode"),
      ),
    );
    expect(missing).toEqual([]);
  });

  it("migrates idempotently and keeps existing rows", async () => {
    const stub = env.COORDINATOR.getByName("idempotent");
    await stub.ping();

    const result = await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec(
        "INSERT INTO entry_counters (mode, session_date, consumed) VALUES ('SIM', '2026-01-05', 2)",
      );
      migrate(state.storage);
      migrate(state.storage);
      return {
        counters: state.storage.sql.exec("SELECT consumed FROM entry_counters").toArray(),
        versions: state.storage.sql.exec("SELECT version FROM schema_migrations").toArray(),
      };
    });
    expect(result.counters).toEqual([{ consumed: 2 }]);
    expect(result.versions).toEqual([{ version: 1 }, { version: 2 }]);
  });

  it("never shares rows between two clients", async () => {
    const alice = env.COORDINATOR.getByName("client-a");
    const bob = env.COORDINATOR.getByName("client-b");
    await alice.ping();
    await bob.ping();

    await runInDurableObject(alice, (_i, state) =>
      state.storage.sql.exec(
        "INSERT INTO entry_counters (mode, session_date, consumed) VALUES ('SIM', '2026-01-05', 1)",
      ),
    );

    const bobRows = await runInDurableObject(bob, (_i, state) =>
      state.storage.sql.exec("SELECT * FROM entry_counters").toArray(),
    );
    expect(bobRows).toEqual([]);
  });
});

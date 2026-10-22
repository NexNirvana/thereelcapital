import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, migrate } from "../src/schema.ts";

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
    expect(result.versions).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
    ]);
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

  describe("position invariants", () => {
    const insertPosition = (
      sql: SqlStorage,
      id: string,
      symbol: string,
      { mode = "SIM", status = "OPEN", soldQty = 0, originalQty = 10 } = {},
    ) =>
      sql.exec(
        `INSERT INTO positions (id, mode, account_id, symbol, original_qty, sold_qty, avg_entry_price,
           stop_pct, trailing_unlock_pct, protection_state, status, opened_on)
         VALUES (?, ?, 'SIM1001', ?, ?, ?, 1000000, 30, 70, 'protected', ?, '2026-10-21')`,
        id,
        mode,
        symbol,
        originalQty,
        soldQty,
        status,
      );

    it("rejects selling more than was bought", async () => {
      const stub = env.COORDINATOR.getByName("oversold");
      await stub.ping();
      await runInDurableObject(stub, (_i, state) => {
        const sql = state.storage.sql;
        insertPosition(sql, "p1", "AAPL", { soldQty: 10 });
        expect(() => insertPosition(sql, "p2", "MSFT", { soldQty: 11 })).toThrow();
        expect(() => sql.exec("UPDATE positions SET sold_qty = 11 WHERE id = 'p1'")).toThrow();
      });
    });

    it("allows one open position per mode and symbol, and a new one after it closes", async () => {
      const stub = env.COORDINATOR.getByName("one-open");
      await stub.ping();
      await runInDurableObject(stub, (_i, state) => {
        const sql = state.storage.sql;
        insertPosition(sql, "p1", "AAPL");
        expect(() => insertPosition(sql, "p2", "AAPL")).toThrow();
        insertPosition(sql, "p3", "AAPL", { mode: "REAL" });
        insertPosition(sql, "p4", "MSFT");
        sql.exec("UPDATE positions SET status = 'CLOSED' WHERE id = 'p1'");
        insertPosition(sql, "p5", "AAPL");
        insertPosition(sql, "p6", "AAPL", { status: "CLOSED" });
      });
    });

    it("upgrades a store that already has positions and steps, keeping every row", async () => {
      const stub = env.COORDINATOR.getByName("upgrade-from-v2");
      await stub.ping();
      const kept = await runInDurableObject(stub, (_i, state) => {
        const sql = state.storage.sql;
        // Rewind to the schema as it shipped at version 2.
        for (const table of [
          "scaleout_steps",
          "positions",
          "intents",
          "entry_counters",
          "events",
          "oauth_attempts",
          "broker_accounts",
          "schema_migrations",
        ]) {
          sql.exec(`DROP TABLE ${table}`);
        }
        migrate(state.storage, MIGRATIONS.slice(0, 2));
        sql.exec(
          `INSERT INTO positions (id, mode, account_id, symbol, original_qty, sold_qty, avg_entry_price,
             stop_pct, trailing_unlock_pct, protection_state, status, opened_on)
           VALUES ('p1', 'SIM', 'SIM1001', 'AAPL', 10, 4, 1000000, 30, 70, 'protected', 'OPEN', '2026-10-21')`,
        );
        sql.exec(
          "INSERT INTO scaleout_steps (position_id, mode, idx, state) VALUES ('p1', 'SIM', 0, 'done')",
        );
        migrate(state.storage);
        return {
          positions: sql.exec("SELECT id, sold_qty FROM positions").toArray(),
          steps: sql.exec("SELECT position_id FROM scaleout_steps").toArray(),
          violations: sql.exec("PRAGMA foreign_key_check").toArray(),
          versions: sql.exec("SELECT MAX(version) AS v FROM schema_migrations").toArray(),
          indexed: sql
            .exec("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'positions'")
            .toArray()
            .map((row) => row.name),
        };
      });
      expect(kept.positions).toEqual([{ id: "p1", sold_qty: 4 }]);
      expect(kept.steps).toEqual([{ position_id: "p1" }]);
      expect(kept.violations).toEqual([]);
      expect(kept.versions).toEqual([{ v: MIGRATIONS.length }]);
      expect(kept.indexed).toEqual(
        expect.arrayContaining(["positions_by_mode_status", "positions_one_open_per_symbol"]),
      );
    });
  });
});

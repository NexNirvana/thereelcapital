import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// The partial index applies only when a query's terms imply its WHERE, so these are the queries'
// exact predicates (sync.ts, reconcile.ts, overview.ts, positions-view.ts).
const OPEN = "state NOT IN ('FILLED', 'CANCELED', 'REJECTED')";

const plan = (sql: SqlStorage, query: string, ...params: (string | number)[]) =>
  sql
    .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, ...params)
    .toArray()
    .map((row) => row.detail)
    .join(" | ");

describe("engine query plans", () => {
  it("serve open intents, history paging and open-position steps from indexes", async () => {
    const stub = env.COORDINATOR.getByName("query-plans-1");
    await stub.ping();
    await runInDurableObject(stub, (_i, state) => {
      const sql = state.storage.sql;
      expect(
        plan(sql, `SELECT * FROM intents WHERE mode = 'SIM' AND ${OPEN} ORDER BY created_at`),
      ).toBe("SEARCH intents USING INDEX intents_open (mode=?)");
      expect(
        plan(
          sql,
          `SELECT id FROM intents WHERE mode = 'SIM' AND kind != 'entry' AND position_id IS NOT NULL AND ${OPEN} ORDER BY created_at, id`,
        ),
      ).toContain("USING INDEX intents_open");
      expect(
        plan(
          sql,
          "SELECT id FROM intents WHERE mode = ? AND (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT ?",
          "SIM",
          5,
          "x",
          51,
        ),
      ).toMatch(/^SEARCH intents USING (COVERING )?INDEX intents_by_mode_created \(mode=\?/);
      expect(
        plan(
          sql,
          `SELECT s.position_id, s.state FROM scaleout_steps s JOIN positions p ON p.id = s.position_id
            WHERE p.mode = 'SIM' AND p.status != 'CLOSED' ORDER BY s.position_id, s.idx`,
        ),
      ).toContain("SEARCH s USING INDEX sqlite_autoindex_scaleout_steps_1 (position_id=?)");
    });
  });

  it("reads only the working intents and the open positions' steps", async () => {
    const stub = env.COORDINATOR.getByName("query-plans-2");
    await stub.ping();
    await runInDurableObject(stub, (_i, state) => {
      const sql = state.storage.sql;
      for (let n = 0; n < 300; n++) {
        sql.exec(
          `INSERT INTO intents (id, mode, kind, account_id, symbol, asset_type, trade_action, qty, state,
             order_confirm_id, created_at, updated_at)
           VALUES (?, 'SIM', 'entry', 'SIM-1', 'AAPL', 'stock', 'BUY', 1, ?, ?, ?, ?)`,
          `i${n}`,
          n < 2 ? "ACKNOWLEDGED" : "FILLED",
          `i${n}`,
          n,
          n,
        );
      }
      const open = sql.exec(
        `SELECT id FROM intents WHERE mode = 'SIM' AND ${OPEN} ORDER BY created_at`,
      );
      expect(open.toArray()).toHaveLength(2);
      // Before the index this read all 300 rows of the mode.
      expect(open.rowsRead).toBeLessThan(10);
    });
  });
});

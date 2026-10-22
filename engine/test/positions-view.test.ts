import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

let counter = 0;
const client = () => env.COORDINATOR.getByName(`positions-view-user-${++counter}`);

describe("positions view", () => {
  it("lists open positions with their steps, and only working orders of a position", async () => {
    const stub = client();
    await stub.ping();
    await runInDurableObject(stub, (_i, state) => {
      const sql = state.storage.sql;
      sql.exec(
        `INSERT INTO positions (id, mode, account_id, symbol, underlying, expiry, strike, right, original_qty, sold_qty,
           avg_entry_price, stop_pct, trailing_unlock_pct, protection_state, status, opened_on)
         VALUES ('p1', 'SIM', 'SIM-1', 'SPY 261120C600', 'SPY', '2026-11-20', 600000000, 'call', 50, 35, 1, 30, 70, 'unverified', 'OPEN', '2026-11-04'),
                ('p2', 'SIM', 'SIM-1', 'AAPL', NULL, NULL, NULL, NULL, 10, 10, 1, 30, 70, 'none', 'CLOSED', '2026-11-04')`,
      );
      const steps = ["done", "done", "done_zero", "pending", "available", "available", "available"];
      steps.forEach((s, idx) =>
        sql.exec(
          "INSERT INTO scaleout_steps (position_id, mode, idx, state) VALUES ('p1', 'SIM', ?, ?)",
          idx,
          s,
        ),
      );
      const insert = (id: string, kind: string, state_: string, brokerId: string | null) =>
        sql.exec(
          `INSERT INTO intents (id, mode, kind, account_id, position_id, symbol, asset_type, trade_action, qty, state,
             filled_qty, order_confirm_id, broker_order_id, created_at, updated_at)
           VALUES (?, 'SIM', ?, 'SIM-1', 'p1', 'SPY 261120C600', 'option', 'SELLTOCLOSE', 5, ?, 0, ?, ?, 1, 1)`,
          id,
          kind,
          state_,
          id,
          brokerId,
        );
      insert("open", "exit", "ACKNOWLEDGED", "BROKER-ID-SECRET");
      insert("sent", "exit", "SENT", null);
      insert("done", "exit", "FILLED", "B2");
      insert("entry", "entry", "ACKNOWLEDGED", "B3");
    });
    const result = await stub.positions({ mode: "SIM" });
    if (!result.ok) throw new Error(result.code);
    const { positions, pending, maxPositions } = result.value;
    expect(maxPositions).toBeGreaterThan(0);
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({
      id: "p1",
      option: {
        underlying: "SPY",
        expiration: "2026-11-20",
        strikeMicros: 600000000,
        right: "call",
      },
      steps: ["done", "done", "done_zero", "pending", "available", "available", "available"],
      protectionState: "unverified",
    });
    expect(pending.map((o) => [o.id, o.cancelable])).toEqual([
      ["open", true],
      ["sent", false],
    ]);
    expect(JSON.stringify(result.value)).not.toMatch(/BROKER-ID/);
  });

  it("refuses REAL and unknown fields", async () => {
    const stub = client();
    expect(await stub.positions({ mode: "REAL" })).toMatchObject({ code: "MODE_NOT_SIM" });
    expect(await stub.positions({ mode: "SIM", positionId: "x" })).toMatchObject({
      code: "INVALID_INPUT",
    });
  });
});

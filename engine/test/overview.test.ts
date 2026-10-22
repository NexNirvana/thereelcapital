import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

let counter = 0;

async function client(connected: boolean) {
  const userId = `overview-user-${++counter}`;
  if (connected) {
    await env.DB.prepare(
      `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'T', ?, 1, 0, 0)`,
    )
      .bind(userId, `${userId}@example.test`)
      .run();
    await env.DB.prepare(
      `INSERT INTO broker_connection
         (user_id, client_id, client_secret_enc, refresh_token_enc, key_id, refresh_expires_at, status, last_ok_at)
       VALUES (?, 'ts-client-id', 'SECRET-ENC', 'TOKEN-ENC', 'k', NULL, 'CONNECTED', 5)`,
    )
      .bind(userId)
      .run();
  }
  return env.COORDINATOR.getByName(userId);
}

describe("overview", () => {
  it("reports a client with no connection and nothing open", async () => {
    const result = await (await client(false)).overview({ mode: "SIM" });
    expect(result).toMatchObject({
      ok: true,
      value: { connection: { status: "NOT_CONNECTED" }, positions: [], orders: [] },
    });
  });

  it("lists open positions, unfinished orders (UNKNOWN included) and the counts, without secrets", async () => {
    const stub = await client(true);
    await stub.ping();
    await runInDurableObject(stub, (_i, state) => {
      const sql = state.storage.sql;
      sql.exec(
        "INSERT INTO broker_accounts (mode, account_id, account_type) VALUES ('SIM', 'SIM-1', 'Margin')",
      );
      sql.exec(
        `INSERT INTO positions (id, mode, account_id, symbol, original_qty, sold_qty, avg_entry_price, stop_pct,
           trailing_unlock_pct, protection_state, status, opened_on)
         VALUES ('p1', 'SIM', 'SIM-1', 'MSFT', 100, 20, 1, 30, 70, 'unverified', 'OPEN', '2026-11-04'),
                ('p2', 'SIM', 'SIM-1', 'AAPL', 10, 10, 1, 30, 70, 'none', 'CLOSED', '2026-11-04')`,
      );
      const insert = (id: string, state_: string, kind = "exit") =>
        sql.exec(
          `INSERT INTO intents (id, mode, kind, account_id, symbol, asset_type, trade_action, qty, state,
             filled_qty, order_confirm_id, broker_order_id, created_at, updated_at)
           VALUES (?, 'SIM', ?, 'SIM-1', 'MSFT', 'equity', 'SELL', 10, ?, 0, ?, 'BROKER-ID-SECRET', 1, 1)`,
          id,
          kind,
          state_,
          id,
        );
      insert("i-unknown", "UNKNOWN");
      insert("i-sent", "SENT");
      insert("i-done", "FILLED");
    });
    const result = await stub.overview({ mode: "SIM" });
    if (!result.ok) throw new Error(result.code);
    const { value } = result;
    expect(value.connection).toMatchObject({
      status: "CONNECTED",
      health: { status: "ok" },
      accounts: [{ accountId: "SIM-1" }],
      lastOkAt: 5,
    });
    expect(value.positions).toEqual([
      expect.objectContaining({ id: "p1", symbol: "MSFT", protectionState: "unverified" }),
    ]);
    expect(value.orders.map((o) => o.state).sort()).toEqual(["SENT", "UNKNOWN"]);
    expect(value.positionsOpen).toBe(1);
    expect(JSON.stringify(value)).not.toMatch(/SECRET|TOKEN-ENC|BROKER-ID/);
  });

  it("refuses REAL and unknown fields", async () => {
    const stub = await client(false);
    expect(await stub.overview({ mode: "REAL" })).toMatchObject({
      ok: false,
      code: "MODE_NOT_SIM",
    });
    expect(await stub.overview({ mode: "SIM", clientId: "x" })).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
  });
});

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { activeModes, isRealTradingOpen, recordModeLocks } from "../src/mode.ts";
import { ClientCoordinator } from "../src/index.ts";
import { logOnce } from "../src/reconcile.ts";
import { newClient } from "./sync-helpers.ts";

describe("activeModes", () => {
  it("is SIM only while the deployment switch is closed, whatever the client flag says", async () => {
    const client = await newClient();
    await runInDurableObject(client.stub, (_i, state) => {
      expect(activeModes(state.storage)).toEqual(["SIM"]);
      recordModeLocks(state.storage, { deploymentOpen: false, clientEnabled: true });
      expect(activeModes(state.storage)).toEqual(["SIM"]);
    });
  });

  it("adds REAL with the switch open and the client flag on", async () => {
    const client = await newClient();
    await runInDurableObject(client.stub, (_i, state) => {
      recordModeLocks(state.storage, { deploymentOpen: true, clientEnabled: false });
      expect(activeModes(state.storage)).toEqual(["SIM"]);
      recordModeLocks(state.storage, { deploymentOpen: true, clientEnabled: true });
      expect(activeModes(state.storage)).toEqual(["SIM", "REAL"]);
    });
  });

  it("keeps REAL while a REAL intent is unfinished, so exits and protections are never stranded", async () => {
    const client = await newClient();
    await runInDurableObject(client.stub, (_i, state) => {
      recordModeLocks(state.storage, { deploymentOpen: true, clientEnabled: false });
      state.storage.sql.exec(
        `INSERT INTO intents (id, mode, kind, account_id, symbol, asset_type, trade_action, qty, state,
                              order_confirm_id, created_at, updated_at)
         VALUES ('i1', 'REAL', 'entry', 'LIVE-1', 'AAPL', 'equity', 'BUY', 1, 'SENT', 'i1', 0, 0)`,
      );
      expect(activeModes(state.storage)).toEqual(["SIM", "REAL"]);
      // The switch closing wins over everything.
      recordModeLocks(state.storage, { deploymentOpen: false, clientEnabled: false });
      expect(activeModes(state.storage)).toEqual(["SIM"]);
    });
  });
});

describe("the client flag", () => {
  it("is read from D1 only while the deployment is open", async () => {
    const client = await newClient();
    await env.DB.prepare("UPDATE client_settings SET real_trading_enabled = 1 WHERE user_id = ?")
      .bind(client.userId)
      .run();
    await runInDurableObject(client.stub, async (instance: ClientCoordinator, state) => {
      await instance["refreshModeLocks"]();
      expect(activeModes(state.storage)).toEqual(["SIM"]); // the test deployment is closed
      // The argument stands in for the deployment switch; the variable itself stays closed.
      await instance["refreshModeLocks"](true);
      expect(activeModes(state.storage)).toEqual(["SIM", "REAL"]);
      await env.DB.prepare("UPDATE client_settings SET real_trading_enabled = 0 WHERE user_id = ?")
        .bind(client.userId)
        .run();
      await instance["refreshModeLocks"](true);
      expect(activeModes(state.storage)).toEqual(["SIM"]);
    });
  });
});

describe("the broker per mode", () => {
  it("builds no REAL broker while the switch is closed, and a REAL one only with it open", async () => {
    const client = await newClient();
    await runInDurableObject(client.stub, (instance: ClientCoordinator, state) => {
      const ctx = (mode: "SIM" | "REAL") => instance["connectionContext"](mode);
      const sim = ctx("SIM");
      const real = ctx("REAL");
      if (sim === null || real === null) throw new Error("no connection context");
      expect(instance["brokerFor"](sim)).not.toBeNull();
      expect(instance["brokerFor"](real)).toBeNull();
      expect(instance["brokerFor"](sim)).toBe(instance["brokerFor"](sim));
      // The argument stands in for the deployment switch; the variable itself stays closed.
      const opened = instance["brokerFor"](real, true);
      expect(opened).not.toBeNull();
      expect(opened).not.toBe(instance["brokerFor"](sim));
      void state;
    });
  });
});

describe("isRealTradingOpen", () => {
  it("opens only for the exact string enabled", () => {
    expect(isRealTradingOpen({ REAL_TRADING: "enabled" })).toBe(true);
    for (const value of [
      undefined,
      "",
      "disabled",
      "ENABLED",
      "Enabled",
      "true",
      "1",
      " enabled",
      "enabled ",
    ]) {
      expect(isRealTradingOpen({ REAL_TRADING: value })).toBe(false);
    }
    expect(isRealTradingOpen({})).toBe(false);
  });
});

describe("conditions logged once", () => {
  it("log once per mode, not once for both passes", async () => {
    const client = await newClient();
    await runInDurableObject(client.stub, (instance: ClientCoordinator, state) => {
      for (const mode of ["SIM", "REAL"] as const) {
        const ctx = instance["connectionContext"](mode);
        if (ctx === null) throw new Error("no connection context");
        logOnce(ctx, "2", "warn", "sync.unknown_pending");
        logOnce(ctx, "2", "warn", "sync.unknown_pending");
      }
      const rows = state.storage.sql
        .exec<{ mode: string }>(
          "SELECT mode FROM events WHERE type = 'sync.unknown_pending' ORDER BY mode",
        )
        .toArray();
      expect(rows.map((row) => row.mode)).toEqual(["REAL", "SIM"]);
    });
  });
});

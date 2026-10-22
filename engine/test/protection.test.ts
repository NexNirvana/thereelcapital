// Engine-held stop (D36): the sync tick compares fresh bids with the stop level and sells through
// the normal exit path. Local simulation only.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { LocalSim } from "../src/broker/local-sim/sim.ts";
import { prepareEntry, sendEntry, type EntryContext } from "../src/entries.ts";
import { STOP_REJECTED_COOLDOWN_MS } from "#lib/domain/config.ts";
import { exitPosition } from "../src/exits.ts";
import { runSync } from "../src/sync.ts";
import { localSimFor } from "../src/broker/provider.ts";
import {
  ACCOUNTS,
  IN_SESSION,
  inClient,
  newClient,
  newSim,
  run,
  usd,
  type Clock,
} from "./sync-helpers.ts";

const ASK = 200;
// stop_pct 30 on the test client: the stop level of a 200 entry is 140.
const STOP_LEVEL = usd(140);

async function openPosition(ctx: EntryContext, sim: LocalSim, qty: number, symbol = "AAPL") {
  await env.DB.prepare("UPDATE client_settings SET size_usd = ? WHERE user_id = ?")
    .bind(ASK * qty, ctx.userId)
    .run();
  sim.setFill({ kind: "instant" });
  const args = { mode: "SIM", accountId: "SIM-1", symbol, assetType: "equity" } as const;
  const prepared = await prepareEntry(ctx, args);
  if (!prepared.ok || prepared.value.status !== "READY") throw new Error("entry not ready");
  await sendEntry(ctx, { ...args, intentId: prepared.value.intentId, confirmedQty: qty });
  await runSync(ctx);
  return ctx.sql
    .exec<{ id: string }>(
      "SELECT id FROM positions WHERE symbol = ? AND status != 'CLOSED'",
      symbol,
    )
    .one().id;
}

const stopIntents = (ctx: EntryContext) =>
  ctx.sql
    .exec<{ qty: number; state: string }>(
      "SELECT qty, state FROM intents WHERE kind = 'stop' ORDER BY created_at, id",
    )
    .toArray();
const sellIntents = (ctx: EntryContext) =>
  ctx.sql
    .exec<{ qty: number }>("SELECT qty FROM intents WHERE kind != 'entry' ORDER BY created_at, id")
    .toArray();
const protection = (ctx: EntryContext, id: string) =>
  ctx.sql
    .exec<{ protection_state: string; status: string; sold_qty: number }>(
      "SELECT protection_state, status, sold_qty FROM positions WHERE id = ?",
      id,
    )
    .one();
const counters = (ctx: EntryContext) =>
  ctx.sql.exec("SELECT consumed, reserved FROM entry_counters WHERE mode = 'SIM'").toArray();

async function scenario(
  body: (
    ctx: EntryContext,
    sim: LocalSim,
    clock: Clock,
    client: Awaited<ReturnType<typeof newClient>>,
  ) => Promise<void>,
) {
  const clock: Clock = { now: IN_SESSION };
  const sim = newSim(clock);
  const client = await newClient();
  await inClient(client, clock, sim.adapter, (ctx) => body(ctx, sim, clock, client));
}

describe("engine-held stop", { timeout: 30_000 }, () => {
  it("is verified while the bid is above the level and sells everything available at it", async () => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 10);
      const before = counters(ctx);

      sim.setQuote("AAPL", { bid: STOP_LEVEL + 1 });
      await runSync(ctx);
      expect(protection(ctx, id).protection_state).toBe("verified");
      expect(stopIntents(ctx)).toEqual([]);

      sim.setQuote("AAPL", { bid: STOP_LEVEL });
      await runSync(ctx);
      expect(stopIntents(ctx)).toEqual([{ qty: 10, state: "ACKNOWLEDGED" }]);
      await runSync(ctx);
      expect(protection(ctx, id)).toMatchObject({ status: "CLOSED", sold_qty: 10 });
      // A stop is an exit: it never touches the entry counters.
      expect(counters(ctx)).toEqual(before);
    });
  });

  it("is not blocked by the entry limits", async () => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 10);
      // The day's three entries are used up.
      ctx.sql.exec("UPDATE entry_counters SET consumed = 3");
      sim.setQuote("AAPL", { bid: STOP_LEVEL - usd(5) });
      await runSync(ctx);
      expect(stopIntents(ctx)).toHaveLength(1);
      await runSync(ctx);
      expect(protection(ctx, id).status).toBe("CLOSED");
    });
  });

  it("waits outside the regular session without calling the exit path", async () => {
    await scenario(async (ctx, sim, clock) => {
      await openPosition(ctx, sim, 10);
      clock.now = Date.UTC(2026, 10, 7, 15, 0, 0); // Saturday
      sim.setQuote("AAPL", { bid: STOP_LEVEL });
      await runSync(ctx);
      expect(stopIntents(ctx)).toEqual([]);
      clock.now = IN_SESSION + 60_000;
      await runSync(ctx);
      expect(stopIntents(ctx)).toHaveLength(1);
    });
  });

  it("waits out a cooldown before a new stop when the broker rejected the last one", async () => {
    await scenario(async (ctx, sim, clock) => {
      await openPosition(ctx, sim, 10);
      sim.setFill({ kind: "delayed", afterMs: 60_000 });
      sim.inject({ kind: "rejectAfterAck" });
      sim.setQuote("AAPL", { bid: STOP_LEVEL });
      await runSync(ctx); // places the stop
      await runSync(ctx); // the broker rejects it; the cooldown holds the next one
      await runSync(ctx);
      expect(stopIntents(ctx)).toEqual([{ qty: 10, state: "REJECTED" }]);
      clock.now += STOP_REJECTED_COOLDOWN_MS;
      await runSync(ctx);
      expect(stopIntents(ctx).map((row) => row.state)).toEqual(["REJECTED", "ACKNOWLEDGED"]);
    });
  });

  it("does not act on a zero bid", async () => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 10);
      sim.setQuote("AAPL", { bid: 0 });
      await runSync(ctx);
      expect(protection(ctx, id).protection_state).toBe("unverified");
      expect(stopIntents(ctx)).toEqual([]);
    });
  });

  it("does not send a second stop while the first is working", async () => {
    await scenario(async (ctx, sim) => {
      await openPosition(ctx, sim, 10);
      sim.setFill({ kind: "delayed", afterMs: 60_000 });
      sim.setQuote("AAPL", { bid: STOP_LEVEL });
      await runSync(ctx);
      await runSync(ctx);
      await runSync(ctx);
      expect(stopIntents(ctx)).toEqual([{ qty: 10, state: "ACKNOWLEDGED" }]);
    });
  });

  it("is unverified on a stale, missing or halted quote and never sells on it", async () => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 10);
      await runSync(ctx);
      expect(protection(ctx, id).protection_state).toBe("verified");

      sim.setQuote("AAPL", { bid: usd(1) });
      sim.inject({ kind: "quoteStale", symbol: "AAPL" });
      await runSync(ctx);
      expect(protection(ctx, id).protection_state).toBe("unverified");

      sim.inject({ kind: "quoteMissing", symbol: "AAPL" });
      await runSync(ctx);
      expect(protection(ctx, id).protection_state).toBe("unverified");

      sim.setQuote("AAPL", { isHalted: true });
      await runSync(ctx);
      expect(protection(ctx, id).protection_state).toBe("unverified");
      expect(stopIntents(ctx)).toEqual([]);
    });
  });

  it("is unverified when the quotes call fails, and verified again once it works", async () => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 10);
      await runSync(ctx);
      sim.inject({ kind: "rateLimited", operation: "quotes" });
      await runSync(ctx);
      expect(protection(ctx, id).protection_state).toBe("unverified");
      await runSync(ctx);
      expect(protection(ctx, id).protection_state).toBe("verified");
    });
  });

  it("is unverified while the token is expired and verified after the broker answers again", async () => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 10);
      await runSync(ctx);
      sim.inject({ kind: "authExpired", operation: "orders" });
      await runSync(ctx);
      expect(protection(ctx, id).protection_state).toBe("unverified");
      await runSync(ctx);
      expect(protection(ctx, id).protection_state).toBe("verified");
    });
  });

  it("sells only what is available when a scale-out step is pending", async () => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 10);
      sim.setFill({ kind: "delayed", afterMs: 60_000 });
      await exitPosition(ctx, { mode: "SIM", positionId: id, step: 0 });
      const stepQty = sellIntents(ctx)[0]?.qty ?? 0;
      expect(stepQty).toBeGreaterThan(0);

      sim.setQuote("AAPL", { bid: STOP_LEVEL });
      await runSync(ctx);
      expect(stopIntents(ctx)).toEqual([{ qty: 10 - stepQty, state: "ACKNOWLEDGED" }]);
    });
  });

  it("never oversells when the stop races ALL OUT", async () => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 10);
      sim.setFill({ kind: "delayed", afterMs: 60_000 });
      sim.setQuote("AAPL", { bid: STOP_LEVEL });
      await Promise.all([
        runSync(ctx),
        exitPosition(ctx, { mode: "SIM", positionId: id, step: "ALL_OUT" }),
        exitPosition(ctx, { mode: "SIM", positionId: id, step: 0 }),
      ]);
      await runSync(ctx);
      const total = sellIntents(ctx).reduce((sum, row) => sum + row.qty, 0);
      expect(total).toBe(10);
    });
  });

  it("reads protection state from storage on every pass", async () => {
    // Protection lives in SQL rows and kv keys only, so a context built over the same storage (as
    // after an eviction) carries on. A genuine second instance is not built here: its alarm would
    // race the test's own broker.
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    const client = await newClient();
    const id = await inClient(client, clock, sim.adapter, async (ctx) => {
      const positionId = await openPosition(ctx, sim, 10);
      await runSync(ctx);
      return positionId;
    });
    sim.setQuote("AAPL", { bid: STOP_LEVEL });
    await inClient(client, clock, sim.adapter, async (ctx) => {
      expect(protection(ctx, id).protection_state).toBe("verified");
      await runSync(ctx);
      expect(stopIntents(ctx)).toHaveLength(1);
    });
  });
});

// docs/test-plan.md: protections keep running after logout. Nothing here calls an RPC or carries a
// session: the Durable Object's own alarm is the only caller, as when the client has closed the app.
describe("protection without a web session", { timeout: 30_000 }, () => {
  it("the alarm tick sells a position whose bid fell to the stop level", async () => {
    const client = await newClient();
    const sim = localSimFor(
      client.userId,
      {
        now: () => IN_SESSION,
        seed: client.userId,
        accounts: ACCOUNTS.map((accountId) => ({ accountId })),
        symbols: [{ symbol: "AAPL", assetType: "equity", bid: usd(199), ask: usd(200) }],
      },
      { reset: true },
    );
    // A position bought elsewhere that the tick adopts, with the stop of the client's settings.
    await run(
      sim.adapter.placeOrder({
        accountId: "SIM-1",
        symbol: "AAPL",
        assetType: "equity",
        tradeAction: "BUY",
        quantity: 10,
        orderConfirmId: "elsewhere-0000000030",
      }),
    );
    sim.setQuote("AAPL", { bid: STOP_LEVEL - usd(5) });

    // Pin the engine's market clock inside the session; the alarm times stay on the wall clock.
    // The tick is due now and the real alarm is parked, so only runDurableObjectAlarm fires it.
    await runInDurableObject(client.stub, (instance, state) => {
      Object.assign(Reflect.get(instance, "env"), { TEST_NOW: new Date(IN_SESSION).toISOString() });
      state.storage.kv.put("alarm_due:sync", Date.now());
      return state.storage.setAlarm(Date.now() + 3_600_000);
    });
    const rows = () =>
      runInDurableObject(client.stub, (_i, state) => ({
        stops: state.storage.sql
          .exec<{ qty: number }>("SELECT qty FROM intents WHERE kind = 'stop'")
          .toArray(),
        positions: state.storage.sql
          .exec<{ status: string }>("SELECT status FROM positions")
          .toArray(),
      }));

    // Tick 1 adopts the position and evaluates the stop; later ticks follow the stop order to its end.
    for (let tick = 0; tick < 3; tick++) {
      await runDurableObjectAlarm(client.stub);
      await runInDurableObject(client.stub, (_i, state) => {
        state.storage.kv.put("alarm_due:sync", Date.now());
        return state.storage.setAlarm(Date.now() + 3_600_000);
      });
    }

    const after = await rows();
    expect(after.stops).toEqual([{ qty: 10 }]);
    expect(after.positions).toEqual([{ status: "CLOSED" }]);
  });
});

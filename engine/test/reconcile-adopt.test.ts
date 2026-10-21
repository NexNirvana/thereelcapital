import { describe, expect, it } from "vitest";
import { prepareEntry, sendEntry, type EntryContext } from "../src/entries.ts";
import { reconcile } from "../src/reconcile.ts";
import {
  IN_SESSION,
  PROTECTION,
  inClient,
  newClient,
  newSim,
  readSnapshot,
  run,
  usd,
  type Clock,
} from "./sync-helpers.ts";

const order = (symbol: string, tradeAction: "BUY" | "SELL", quantity: number, confirm: string) =>
  ({
    accountId: "SIM-1",
    symbol,
    assetType: "equity",
    tradeAction,
    quantity,
    orderConfirmId: confirm,
  }) as const;

async function pass(ctx: EntryContext, broker: EntryContext["broker"]) {
  return reconcile(
    { sql: ctx.sql, storage: ctx.storage, now: ctx.now },
    await readSnapshot(broker),
    PROTECTION,
  );
}

const positions = (ctx: EntryContext) =>
  ctx.sql
    .exec(
      "SELECT symbol, original_qty, sold_qty, avg_entry_price, status, source, protection_state FROM positions ORDER BY symbol",
    )
    .toArray();
const counters = (ctx: EntryContext) =>
  ctx.sql.exec("SELECT consumed, reserved FROM entry_counters").toArray();
const events = (ctx: EntryContext, type: string) =>
  ctx.sql.exec("SELECT level FROM events WHERE type = ?", type).toArray();

describe("adopting external activity", () => {
  it("adopts positions that already exist at the broker, without touching the daily counters", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    await run(sim.adapter.placeOrder(order("AAPL", "BUY", 60, "elsewhere-0000000001")));
    const client = await newClient();
    await inClient(client, clock, sim.adapter, async (ctx) => {
      await pass(ctx, sim.adapter);
      await pass(ctx, sim.adapter);

      expect(positions(ctx)).toEqual([
        {
          symbol: "AAPL",
          original_qty: 60,
          sold_qty: 0,
          avg_entry_price: usd(200),
          status: "OPEN",
          source: "external",
          protection_state: "none",
        },
      ]);
      expect(ctx.sql.exec("SELECT COUNT(*) AS n FROM scaleout_steps").one()).toEqual({ n: 7 });
      expect(counters(ctx)).toEqual([]);
      expect(events(ctx, "reconcile.position_adopted")).toHaveLength(1);
      // It takes a slot: with a second one adopted there is no room for an entry.
      await run(sim.adapter.placeOrder(order("MSFT", "BUY", 10, "elsewhere-0000000002")));
      await pass(ctx, sim.adapter);
      expect(
        await prepareEntry(ctx, {
          mode: "SIM",
          accountId: "SIM-1",
          symbol: "NVDA",
          assetType: "equity",
        }),
      ).toMatchObject({
        value: { status: "BLOCKED", reasons: ["OPEN_POSITION_LIMIT"] },
      });
    });
  });

  it("adopts an open external sell as an exit that counts against what can be sold", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    const client = await newClient();
    await inClient(client, clock, sim.adapter, async (ctx) => {
      const prepared = await prepareEntry(ctx, {
        mode: "SIM",
        accountId: "SIM-1",
        symbol: "AAPL",
        assetType: "equity",
      });
      if (!prepared.ok || prepared.value.status !== "READY") throw new Error("not ready");
      await sendEntry(ctx, {
        mode: "SIM",
        accountId: "SIM-1",
        symbol: "AAPL",
        assetType: "equity",
        intentId: prepared.value.intentId,
        confirmedQty: prepared.value.qty,
      });
      await pass(ctx, sim.adapter);
      // Another terminal puts in a sell that will fill later.
      sim.setFill({ kind: "delayed", afterMs: 30_000 });
      await run(sim.adapter.placeOrder(order("AAPL", "SELL", 40, "elsewhere-0000000003")));

      await pass(ctx, sim.adapter);
      expect(
        ctx.sql
          .exec(
            "SELECT kind, state, qty, source, position_id IS NOT NULL AS linked FROM intents WHERE source = 'external'",
          )
          .toArray(),
      ).toEqual([{ kind: "exit", state: "ACKNOWLEDGED", qty: 40, source: "external", linked: 1 }]);

      // When it fills, the sold quantity follows the broker, and the entry counters stay put.
      clock.now += 30_000;
      await pass(ctx, sim.adapter);
      expect(positions(ctx)[0]).toMatchObject({ sold_qty: 40, status: "OPEN" });
      expect(counters(ctx)).toEqual([{ consumed: 1, reserved: 0 }]);
    });
  });

  it("counts the fills an external sell already had when it is adopted", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    await run(sim.adapter.placeOrder(order("AAPL", "BUY", 100, "elsewhere-0000000005")));
    const client = await newClient();
    await inClient(client, clock, sim.adapter, async (ctx) => {
      await pass(ctx, sim.adapter);
      // Another terminal's sell has filled 20 of 50 when we first see it.
      sim.setFill({ kind: "partial", qty: 20 });
      await run(sim.adapter.placeOrder(order("AAPL", "SELL", 50, "elsewhere-0000000006")));

      await pass(ctx, sim.adapter);
      await pass(ctx, sim.adapter);

      expect(positions(ctx)[0]).toMatchObject({ sold_qty: 20, status: "OPEN" });
    });
  });

  it("adopts an open external buy as an entry that holds a slot but consumes nothing", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    sim.setFill({ kind: "delayed", afterMs: 30_000 });
    await run(sim.adapter.placeOrder(order("AAPL", "BUY", 25, "elsewhere-0000000004")));
    const client = await newClient();
    await inClient(client, clock, sim.adapter, async (ctx) => {
      await pass(ctx, sim.adapter);
      expect(ctx.sql.exec("SELECT kind, state, source FROM intents").toArray()).toEqual([
        { kind: "entry", state: "ACKNOWLEDGED", source: "external" },
      ]);
      expect(positions(ctx)).toEqual([]);

      clock.now += 30_000;
      await pass(ctx, sim.adapter);
      // Its fill became one position (not two), and no entry of ours was consumed.
      expect(positions(ctx).map((p) => [p.symbol, p.original_qty, p.source])).toEqual([
        ["AAPL", 25, "external"],
      ]);
      expect(counters(ctx)).toEqual([]);
    });
  });

  it("does not adopt our own entry's fill as an external position", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    sim.setFill({ kind: "partial", qty: 30 });
    const client = await newClient();
    await inClient(client, clock, sim.adapter, async (ctx) => {
      const prepared = await prepareEntry(ctx, {
        mode: "SIM",
        accountId: "SIM-1",
        symbol: "AAPL",
        assetType: "equity",
      });
      if (!prepared.ok || prepared.value.status !== "READY") throw new Error("not ready");
      await sendEntry(ctx, {
        mode: "SIM",
        accountId: "SIM-1",
        symbol: "AAPL",
        assetType: "equity",
        intentId: prepared.value.intentId,
        confirmedQty: prepared.value.qty,
      });
      await pass(ctx, sim.adapter);
      // 30 shares are held at the broker, from an entry that is still working.
      expect(positions(ctx)).toEqual([]);
      expect(events(ctx, "reconcile.position_adopted")).toHaveLength(0);
    });
  });
});

import { describe, expect, it } from "vitest";
import { prepareEntry, sendEntry, type EntryContext } from "../src/entries.ts";
import type { BrokerSkip } from "../src/broker/adapter.ts";
import { reconcile } from "../src/reconcile.ts";
import { makeTransport } from "../src/tradestation/http.ts";
import * as tsOrders from "../src/tradestation/orders.ts";
import {
  IN_SESSION,
  newClient,
  newSim,
  PROTECTION,
  inClient,
  readSnapshot,
  run,
  usd,
  type Clock,
} from "./sync-helpers.ts";
import { json, okToken, scriptedFetch } from "./tradestation/helpers.ts";

const target = (symbol: string) =>
  ({ mode: "SIM", accountId: "SIM-1", symbol, assetType: "equity" }) as const;

async function enter(ctx: EntryContext, symbol: string): Promise<string> {
  const prepared = await prepareEntry(ctx, target(symbol));
  if (!prepared.ok || prepared.value.status !== "READY") throw new Error("not ready");
  const sent = await sendEntry(ctx, {
    ...target(symbol),
    intentId: prepared.value.intentId,
    confirmedQty: prepared.value.qty,
  });
  if (!sent.ok || sent.value.status !== "PLACED") throw new Error("not placed");
  return prepared.value.intentId;
}

async function pass(ctx: EntryContext, broker: EntryContext["broker"]) {
  return reconcile(
    { sql: ctx.sql, storage: ctx.storage, now: ctx.now },
    await readSnapshot(broker),
    PROTECTION,
  );
}

const counters = (ctx: EntryContext) =>
  ctx.sql.exec("SELECT consumed, reserved FROM entry_counters WHERE mode = 'SIM'").toArray();
const intent = (ctx: EntryContext, id: string) =>
  ctx.sql
    .exec("SELECT state, filled_qty, avg_fill_price, position_id FROM intents WHERE id = ?", id)
    .one();
const positions = (ctx: EntryContext) =>
  ctx.sql
    .exec(
      "SELECT symbol, original_qty, sold_qty, avg_entry_price, stop_pct, trailing_unlock_pct, status, source FROM positions ORDER BY symbol",
    )
    .toArray();

describe("applying order status and fills", () => {
  it("fills an entry: consumes the reservation, opens the position, fixes original_qty", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    const client = await newClient();
    await inClient(client, clock, sim.adapter, async (ctx) => {
      const id = await enter(ctx, "AAPL");
      expect(counters(ctx)).toEqual([{ consumed: 0, reserved: 1 }]);

      await pass(ctx, sim.adapter);

      expect(intent(ctx, id)).toMatchObject({ state: "FILLED", filled_qty: 100 });
      expect(counters(ctx)).toEqual([{ consumed: 1, reserved: 0 }]);
      expect(positions(ctx)).toEqual([
        {
          symbol: "AAPL",
          original_qty: 100,
          sold_qty: 0,
          avg_entry_price: usd(200),
          stop_pct: 30,
          trailing_unlock_pct: 70,
          status: "OPEN",
          source: "app",
        },
      ]);
      expect(
        ctx.sql.exec("SELECT COUNT(*) AS n FROM scaleout_steps WHERE state = 'available'").one(),
      ).toEqual({ n: 7 });
    });
  });

  it("fills our own entry whose average FilledPrice carries more than six decimals", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    const client = await newClient();
    await inClient(client, clock, sim.adapter, async (ctx) => {
      const id = await enter(ctx, "AAPL");
      const [placed] = await run(sim.adapter.orders(["SIM-1"]));
      if (placed === undefined) throw new Error("no order");
      const wire = {
        OrderID: placed.orderId,
        AccountID: placed.accountId,
        Status: "FLL",
        FilledPrice: "200.5733333333",
        OpenedDateTime: new Date(placed.openedAt).toISOString(),
        ClosedDateTime: new Date(placed.openedAt).toISOString(),
        Legs: [
          {
            AssetType: "STOCK",
            BuyOrSell: "Buy",
            OpenOrClose: "Open",
            QuantityOrdered: String(placed.quantity),
            ExecQuantity: String(placed.quantity),
            QuantityRemaining: "0",
            Symbol: placed.symbol,
          },
        ],
      };
      const script = scriptedFetch(() => json({ Orders: [wire] }));
      const made = makeTransport({
        mode: "SIM",
        accessToken: okToken,
        fetch: script.fetch,
        retryDelayMs: 0,
      });
      if (!made.ok) throw new Error(made.reason);
      const skipped: BrokerSkip[] = [];
      const decoded = await run(tsOrders.orders(made.transport, ["SIM-1"], skipped));
      expect(skipped).toEqual([]);
      const snapshot = { ...(await readSnapshot(sim.adapter)), orders: decoded };
      await reconcile({ sql: ctx.sql, storage: ctx.storage, now: ctx.now }, snapshot, PROTECTION);

      expect(intent(ctx, id)).toMatchObject({ state: "FILLED", avg_fill_price: 200_573_333 });
    });
  });

  it("is idempotent: a second pass changes no counter, position or step", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    const client = await newClient();
    await inClient(client, clock, sim.adapter, async (ctx) => {
      await enter(ctx, "AAPL");
      await pass(ctx, sim.adapter);
      ctx.sql.exec("UPDATE scaleout_steps SET state = 'done' WHERE idx = 0");
      await pass(ctx, sim.adapter);
      await pass(ctx, sim.adapter);

      expect(counters(ctx)).toEqual([{ consumed: 1, reserved: 0 }]);
      expect(positions(ctx)).toHaveLength(1);
      expect(ctx.sql.exec("SELECT state FROM scaleout_steps WHERE idx = 0").one()).toEqual({
        state: "done",
      });
    });
  });

  it("applies partial fills: consumes once at the first, holds the slot, opens the position at the end", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    sim.setFill({ kind: "partial", qty: 40, completeAfterMs: 10_000 });
    const client = await newClient();
    await inClient(client, clock, sim.adapter, async (ctx) => {
      const id = await enter(ctx, "AAPL");

      await pass(ctx, sim.adapter);
      expect(intent(ctx, id)).toMatchObject({
        state: "PARTIAL",
        filled_qty: 40,
        position_id: null,
      });
      expect(counters(ctx)).toEqual([{ consumed: 1, reserved: 0 }]);
      expect(positions(ctx)).toEqual([]);

      // The partially filled entry still holds a slot: with MSFT that makes the two allowed.
      expect(await prepareEntry(ctx, target("MSFT"))).toMatchObject({ value: { status: "READY" } });
      await enter(ctx, "MSFT");
      expect(await prepareEntry(ctx, target("NVDA"))).toMatchObject({
        value: { status: "BLOCKED", reasons: ["OPEN_POSITION_LIMIT"] },
      });

      clock.now += 10_000;
      await pass(ctx, sim.adapter);
      expect(intent(ctx, id)).toMatchObject({ state: "FILLED", filled_qty: 100 });
      expect(counters(ctx)).toEqual([{ consumed: 2, reserved: 0 }]);
      expect(positions(ctx).map((p) => [p.symbol, p.original_qty])).toEqual([
        ["AAPL", 100],
        ["MSFT", 100],
      ]);
    });
  });

  it("releases the reservation and the slot of an entry rejected after the acknowledgement", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    sim.inject({ kind: "rejectAfterAck" });
    const client = await newClient();
    await inClient(client, clock, sim.adapter, async (ctx) => {
      const id = await enter(ctx, "AAPL");
      expect(counters(ctx)).toEqual([{ consumed: 0, reserved: 1 }]);

      await pass(ctx, sim.adapter);

      expect(intent(ctx, id)).toMatchObject({ state: "REJECTED", filled_qty: 0 });
      expect(counters(ctx)).toEqual([{ consumed: 0, reserved: 0 }]);
      expect(positions(ctx)).toEqual([]);
      expect(await prepareEntry(ctx, target("AAPL"))).toMatchObject({ value: { status: "READY" } });
    });
  });

  it("a cancel that races a fill ends FILLED with the position, never as a hidden fill", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    sim.setFill({ kind: "delayed", afterMs: 1_000 });
    sim.inject({ kind: "fillRacesCancel" });
    const client = await newClient();
    await inClient(client, clock, sim.adapter, async (ctx) => {
      const id = await enter(ctx, "AAPL");
      const orderId = ctx.sql
        .exec<{ broker_order_id: string }>("SELECT broker_order_id FROM intents WHERE id = ?", id)
        .one().broker_order_id;
      ctx.sql.exec("UPDATE intents SET state = 'CANCEL_PENDING' WHERE id = ?", id);
      await run(sim.adapter.cancelOrder("SIM-1", orderId)).catch(() => undefined);

      await pass(ctx, sim.adapter);

      expect(intent(ctx, id)).toMatchObject({ state: "FILLED", filled_qty: 100 });
      expect(counters(ctx)).toEqual([{ consumed: 1, reserved: 0 }]);
      expect(positions(ctx)).toHaveLength(1);
    });
  });

  it("keeps a CANCEL_PENDING intent pending while the broker still shows it open", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    sim.setFill({ kind: "delayed", afterMs: 60_000 });
    const client = await newClient();
    await inClient(client, clock, sim.adapter, async (ctx) => {
      const id = await enter(ctx, "AAPL");
      ctx.sql.exec("UPDATE intents SET state = 'CANCEL_PENDING' WHERE id = ?", id);
      await pass(ctx, sim.adapter);
      expect(intent(ctx, id)).toMatchObject({ state: "CANCEL_PENDING", filled_qty: 0 });
    });
  });

  it("closes the position only when the broker reports zero remaining", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    const client = await newClient();
    await inClient(client, clock, sim.adapter, async (ctx) => {
      await enter(ctx, "AAPL");
      await pass(ctx, sim.adapter);
      expect(positions(ctx)[0]).toMatchObject({ status: "OPEN" });

      // Sold elsewhere, in part: the holding shrinks but the position stays open.
      await run(
        sim.adapter.placeOrder({
          accountId: "SIM-1",
          symbol: "AAPL",
          assetType: "equity",
          tradeAction: "SELL",
          quantity: 30,
          orderConfirmId: "external-sale-0000000a",
        }),
      );
      await pass(ctx, sim.adapter);
      expect(positions(ctx)[0]).toMatchObject({ status: "OPEN", sold_qty: 30 });

      await run(
        sim.adapter.placeOrder({
          accountId: "SIM-1",
          symbol: "AAPL",
          assetType: "equity",
          tradeAction: "SELL",
          quantity: 70,
          orderConfirmId: "external-sale-0000000b",
        }),
      );
      await pass(ctx, sim.adapter);
      expect(positions(ctx)[0]).toMatchObject({ status: "CLOSED", sold_qty: 100 });
      // The slot is free again.
      expect(await prepareEntry(ctx, target("AAPL"))).toMatchObject({ value: { status: "READY" } });
    });
  });

  it("keeps the ledger exact when entries and reconciliation passes interleave", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    const client = await newClient();
    await inClient(client, clock, sim.adapter, async (ctx) => {
      const settled = await Promise.allSettled([
        enter(ctx, "AAPL"),
        pass(ctx, sim.adapter),
        enter(ctx, "MSFT"),
        pass(ctx, sim.adapter),
        enter(ctx, "NVDA"),
        pass(ctx, sim.adapter),
      ]);
      // Two slots: exactly two entries got through, whatever the order of the awaits.
      expect(settled.filter((r, i) => i % 2 === 0 && r.status === "fulfilled")).toHaveLength(2);
      await pass(ctx, sim.adapter);

      const [{ consumed, reserved }] = counters(ctx) as { consumed: number; reserved: number }[];
      expect({ consumed, reserved }).toEqual({ consumed: 2, reserved: 0 });
      expect(positions(ctx)).toHaveLength(2);
    });
  });
});

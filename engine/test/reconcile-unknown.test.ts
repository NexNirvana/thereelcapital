import { describe, expect, it } from "vitest";
import { prepareEntry, sendEntry, type EntryContext } from "../src/entries.ts";
import { reconcile } from "../src/reconcile.ts";
import { SEND_GRACE_MS } from "#lib/domain/config.ts";
import {
  IN_SESSION,
  PROTECTION,
  inClient,
  newClient,
  newSim,
  readSnapshot,
  run,
  withoutConfirmIds,
  type Clock,
} from "./sync-helpers.ts";

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

const intent = (ctx: EntryContext, id: string) =>
  ctx.sql
    .exec("SELECT state, broker_order_id, filled_qty, position_id FROM intents WHERE id = ?", id)
    .one();
const counters = (ctx: EntryContext) =>
  ctx.sql.exec("SELECT consumed, reserved FROM entry_counters WHERE mode = 'SIM'").toArray();
const events = (ctx: EntryContext, type: string) =>
  ctx.sql.exec("SELECT level, data_json FROM events WHERE type = ?", type).toArray();
const buy = (symbol: string, quantity: number, confirm: string) =>
  ({
    accountId: "SIM-1",
    symbol,
    assetType: "equity",
    tradeAction: "BUY",
    quantity,
    orderConfirmId: confirm,
  }) as const;

describe("resolving UNKNOWN intents", () => {
  it("after a restart, finds the order by OrderConfirmID when the broker echoes it", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    sim.inject({ kind: "dropPlaceResponse" });
    const client = await newClient();
    const id = await inClient(client, clock, sim.adapter, async (ctx) => {
      const id = await enter(ctx, "AAPL");
      expect(intent(ctx, id)).toMatchObject({ state: "UNKNOWN", broker_order_id: null });
      return id;
    });

    // A new execution context over the same storage: nothing but the database survives.
    await inClient(client, clock, sim.adapter, async (ctx) => {
      await pass(ctx, sim.adapter);
      expect(intent(ctx, id)).toMatchObject({ state: "FILLED", filled_qty: 100 });
      expect(intent(ctx, id).broker_order_id).not.toBeNull();
      expect(counters(ctx)).toEqual([{ consumed: 1, reserved: 0 }]);
      expect(ctx.sql.exec("SELECT COUNT(*) AS n FROM positions").one()).toEqual({ n: 1 });
      // Resolved by the id, not by guessing, and no second order was ever placed.
      expect(events(ctx, "reconcile.confirm_match")).toHaveLength(1);
      expect(events(ctx, "reconcile.fallback_match")).toHaveLength(0);
      expect(await run(sim.adapter.orders(["SIM-1"]))).toHaveLength(1);
    });
  });

  it("after a restart, falls back to account, symbol, action, quantity and time", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    const broker = withoutConfirmIds(sim.adapter);
    sim.inject({ kind: "dropPlaceResponse" });
    const client = await newClient();
    const id = await inClient(client, clock, broker, (ctx) => enter(ctx, "AAPL"));

    await inClient(client, clock, broker, async (ctx) => {
      await pass(ctx, broker);
      expect(intent(ctx, id)).toMatchObject({ state: "FILLED", filled_qty: 100 });
      expect(events(ctx, "reconcile.fallback_match")).toHaveLength(1);
    });
  });

  it("does not adopt an order older than the intent", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    const broker = withoutConfirmIds(sim.adapter);
    // Same shape as the coming entry, but placed an hour earlier by someone else.
    clock.now -= 3_600_000;
    await run(sim.adapter.placeOrder(buy("AAPL", 100, "someone-else-000000001")));
    clock.now += 3_600_000;
    sim.inject({ kind: "dropPlaceResponse" });
    const client = await newClient();
    await inClient(client, clock, broker, async (ctx) => {
      const id = await enter(ctx, "AAPL");
      await pass(ctx, broker);
      expect(intent(ctx, id)).toMatchObject({ state: "FILLED" });
      // The fit is the new order only: the hour-old one stays external.
      expect(events(ctx, "reconcile.ambiguous")).toHaveLength(0);
    });
  });

  it("never guesses when two orders fit: the intent stays UNKNOWN and keeps its reservations", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    const broker = withoutConfirmIds(sim.adapter);
    sim.inject({ kind: "dropPlaceResponse" });
    const client = await newClient();
    await inClient(client, clock, broker, async (ctx) => {
      const id = await enter(ctx, "AAPL");
      // Another terminal buys the same thing right after.
      clock.now += 1_000;
      await run(sim.adapter.placeOrder(buy("AAPL", 100, "someone-else-000000002")));

      await pass(ctx, broker);
      await pass(ctx, broker);

      expect(intent(ctx, id)).toMatchObject({ state: "UNKNOWN", broker_order_id: null });
      expect(counters(ctx)).toEqual([{ consumed: 0, reserved: 1 }]);
      // Logged once, not on every tick; and the position at the broker is not taken as external.
      expect(events(ctx, "reconcile.ambiguous")).toHaveLength(1);
      expect(ctx.sql.exec("SELECT COUNT(*) AS n FROM positions").one()).toEqual({ n: 0 });
      expect(
        ctx.sql.exec("SELECT COUNT(*) AS n FROM intents WHERE source = 'external'").one(),
      ).toEqual({ n: 0 });
    });
  });

  it("keeps an UNKNOWN intent with no matching order, and says so once", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    const client = await newClient();
    await inClient(client, clock, sim.adapter, async (ctx) => {
      const id = await enter(ctx, "AAPL");
      // Pretend the place request never reached the broker and the answer was lost.
      ctx.sql.exec("UPDATE intents SET state = 'UNKNOWN', broker_order_id = NULL WHERE id = ?", id);
      const empty = newSim(clock);

      await pass(ctx, empty.adapter);
      await pass(ctx, empty.adapter);

      expect(intent(ctx, id)).toMatchObject({ state: "UNKNOWN" });
      expect(counters(ctx)).toEqual([{ consumed: 0, reserved: 1 }]);
      expect(events(ctx, "reconcile.unresolved")).toHaveLength(1);
    });
  });

  it("rejects and releases an ARMED intent left by a crash before it was sent", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    const client = await newClient();
    await inClient(client, clock, sim.adapter, async (ctx) => {
      const id = await enter(ctx, "AAPL");
      ctx.sql.exec("UPDATE intents SET state = 'ARMED', broker_order_id = NULL WHERE id = ?", id);
      const empty = newSim(clock);

      await pass(ctx, empty.adapter);

      expect(intent(ctx, id)).toMatchObject({ state: "REJECTED" });
      expect(counters(ctx)).toEqual([{ consumed: 0, reserved: 0 }]);
      expect(events(ctx, "reconcile.armed_never_sent")).toHaveLength(1);
    });
  });

  it("never claims someone else's order for an ARMED intent: it is released and the order adopted", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    const broker = withoutConfirmIds(sim.adapter);
    sim.setFill({ kind: "delayed", afterMs: 60_000 });
    const client = await newClient();
    await inClient(client, clock, broker, async (ctx) => {
      const id = await enter(ctx, "AAPL");
      ctx.sql.exec("UPDATE intents SET state = 'ARMED', broker_order_id = NULL WHERE id = ?", id);
      // Our order is not at the broker (never sent); another terminal's order has the same shape.
      const elsewhere = newSim(clock);
      elsewhere.setFill({ kind: "delayed", afterMs: 60_000 });
      await run(elsewhere.adapter.placeOrder(buy("AAPL", 100, "someone-else-000000003")));

      await pass(ctx, withoutConfirmIds(elsewhere.adapter));

      expect(intent(ctx, id)).toMatchObject({ state: "REJECTED", broker_order_id: null });
      expect(counters(ctx)).toEqual([{ consumed: 0, reserved: 0 }]);
      expect(
        ctx.sql.exec("SELECT kind, source FROM intents WHERE source = 'external'").toArray(),
      ).toEqual([{ kind: "entry", source: "external" }]);
      expect(ctx.sql.exec("SELECT COUNT(*) AS n FROM positions").one()).toEqual({ n: 0 });
    });
  });

  it("leaves a recent SENT intent alone and makes an old one UNKNOWN", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    const client = await newClient();
    await inClient(client, clock, sim.adapter, async (ctx) => {
      const id = await enter(ctx, "AAPL");
      ctx.sql.exec(
        "UPDATE intents SET state = 'SENT', broker_order_id = NULL, updated_at = ? WHERE id = ?",
        clock.now,
        id,
      );
      const empty = newSim(clock);

      await pass(ctx, empty.adapter);
      expect(intent(ctx, id)).toMatchObject({ state: "SENT" });

      clock.now += SEND_GRACE_MS;
      await pass(ctx, empty.adapter);
      expect(intent(ctx, id)).toMatchObject({ state: "UNKNOWN" });
      expect(counters(ctx)).toEqual([{ consumed: 0, reserved: 1 }]);
    });
  });

  it("does not adopt an order as external while a SENT intent of ours could own it", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    const broker = withoutConfirmIds(sim.adapter);
    sim.setFill({ kind: "delayed", afterMs: 60_000 });
    const client = await newClient();
    await inClient(client, clock, broker, async (ctx) => {
      const id = await enter(ctx, "AAPL");
      // The place response is still in flight: the order exists, our row has no OrderID yet.
      ctx.sql.exec(
        "UPDATE intents SET state = 'SENT', broker_order_id = NULL, updated_at = ? WHERE id = ?",
        clock.now,
        id,
      );

      await pass(ctx, broker);

      expect(
        ctx.sql.exec("SELECT COUNT(*) AS n FROM intents WHERE source = 'external'").one(),
      ).toEqual({ n: 0 });
      // The fallback did find it, so the intent follows the order.
      expect(intent(ctx, id)).toMatchObject({ state: "ACKNOWLEDGED" });
    });
  });
});

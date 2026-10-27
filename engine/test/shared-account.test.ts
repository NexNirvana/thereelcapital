// Owner decision 2026-10-27 (docs/decisions.md D49): several app clients may share one TradeStation
// key, even the same login and SIM accounts. "Client B" below is another client's Durable Object:
// to this one it is only orders and holdings on the same account that it did not place.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { LocalSim } from "../src/broker/local-sim/sim.ts";
import { limitCounts, prepareEntry, sendEntry, type EntryContext } from "../src/entries.ts";
import { exitPosition } from "../src/exits.ts";
import { newIntentId } from "../src/ids.ts";
import { runSync } from "../src/sync.ts";
import { IN_SESSION, inClient, newClient, newSim, run, type Clock } from "./sync-helpers.ts";

const ASK = 200;

/** Opens `symbol` with exactly `qty` shares for this client, like exits.test.ts does. */
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

/** What another app client does on the shared account: an order with an intent-shaped confirm id. */
const otherClientOrder = (sim: LocalSim, tradeAction: "BUY" | "SELL", quantity: number) =>
  run(
    sim.adapter.placeOrder({
      accountId: "SIM-1",
      symbol: "AAPL",
      assetType: "equity",
      tradeAction,
      quantity,
      orderConfirmId: newIntentId(),
    }),
  );

/** Whether a new entry on another symbol can still be prepared. */
const openSecondEntry = async (ctx: EntryContext) => {
  const prepared = await prepareEntry(ctx, {
    mode: "SIM",
    accountId: "SIM-1",
    symbol: "MSFT",
    assetType: "equity",
  });
  return prepared.ok && prepared.value.status === "READY";
};

const allOut = async (ctx: EntryContext, positionId: string) => {
  const result = await exitPosition(ctx, { mode: "SIM", positionId, step: "ALL_OUT" });
  expect(result.ok).toBe(true);
};

const positions = (ctx: EntryContext) =>
  ctx.sql.exec("SELECT symbol, original_qty, sold_qty, status, source FROM positions").toArray();

async function scenario(body: (ctx: EntryContext, sim: LocalSim, clock: Clock) => Promise<void>) {
  const clock: Clock = { now: IN_SESSION };
  const sim = newSim(clock);
  const client = await newClient();
  await inClient(client, clock, sim.adapter, (ctx) => body(ctx, sim, clock));
}

describe("a TradeStation account shared with another app client", { timeout: 30_000 }, () => {
  it("closes a position whose own exits sold all of it while the other client still holds the symbol", async () => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 100);
      await otherClientOrder(sim, "BUY", 40); // the account now holds 140
      await allOut(ctx, id);
      await runSync(ctx);
      await runSync(ctx);
      expect(positions(ctx)).toEqual([
        { symbol: "AAPL", original_qty: 100, sold_qty: 100, status: "CLOSED", source: "app" },
      ]);
    });
  });

  it("does not take the other client's remaining holding as a new position after closing", async () => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 100);
      await otherClientOrder(sim, "BUY", 40);
      await allOut(ctx, id);
      await runSync(ctx);
      await runSync(ctx);
      await runSync(ctx);
      expect(positions(ctx).filter((position) => position.status !== "CLOSED")).toEqual([]);
    });
  });

  it("closes even while the other client's open sell is taken for an exit on our position", async () => {
    await scenario(async (ctx, sim, clock) => {
      const id = await openPosition(ctx, sim, 100);
      await otherClientOrder(sim, "BUY", 40);
      sim.setFill({ kind: "delayed", afterMs: 60_000 });
      await allOut(ctx, id);
      // The other client's sell stays open far longer: the broker's listing does not say whose it is.
      sim.setFill({ kind: "delayed", afterMs: 600_000 });
      await otherClientOrder(sim, "SELL", 40);
      await runSync(ctx);
      expect(
        ctx.sql.exec("SELECT kind, source FROM intents WHERE source = 'external'").toArray(),
      ).toEqual([{ kind: "exit", source: "external" }]);

      clock.now += 60_000;
      await runSync(ctx);
      await runSync(ctx);
      expect(positions(ctx)[0]).toMatchObject({ status: "CLOSED", sold_qty: 100 });
    });
  });

  it("keeps ours open while its own exit has not filled, whatever the account holds", async () => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 100);
      await otherClientOrder(sim, "BUY", 40);
      sim.setFill({ kind: "partial", qty: 30 });
      await allOut(ctx, id);
      await runSync(ctx);
      expect(positions(ctx)[0]).toMatchObject({ status: "OPEN", sold_qty: 30 });
    });
  });

  it("still treats an order placed outside any app as an external exit that moves the sold quantity", async () => {
    await scenario(async (ctx, sim) => {
      await openPosition(ctx, sim, 100);
      await otherClientOrder(sim, "SELL", 30);
      await runSync(ctx);
      await runSync(ctx);
      expect(positions(ctx)[0]).toMatchObject({ status: "OPEN", sold_qty: 30 });
    });
  });

  it("closes once when sync passes overlap", async () => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 100);
      await otherClientOrder(sim, "BUY", 40);
      await allOut(ctx, id);
      await Promise.all([runSync(ctx), runSync(ctx), runSync(ctx)]);
      expect(positions(ctx)).toEqual([
        { symbol: "AAPL", original_qty: 100, sold_qty: 100, status: "CLOSED", source: "app" },
      ]);
      expect(
        ctx.sql
          .exec("SELECT COUNT(*) AS n FROM events WHERE type = 'reconcile.position_closed'")
          .one(),
      ).toEqual({ n: 1 });
    });
  });

  it("adopts a new holding of the symbol once the account has held none", async () => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 100);
      await otherClientOrder(sim, "BUY", 40);
      await allOut(ctx, id);
      await runSync(ctx);
      await runSync(ctx);
      expect(positions(ctx).filter((position) => position.status !== "CLOSED")).toEqual([]);

      await otherClientOrder(sim, "SELL", 40); // the account is flat
      await runSync(ctx);
      await otherClientOrder(sim, "BUY", 25); // a later, new holding
      await runSync(ctx);
      await runSync(ctx);
      expect(positions(ctx).filter((position) => position.status !== "CLOSED")).toMatchObject([
        { original_qty: 25, source: "external" },
      ]);
    });
  });
  it("closes a position whose sold quantity came partly from an order made elsewhere", async () => {
    await scenario(async (ctx, sim, clock) => {
      const id = await openPosition(ctx, sim, 100);
      await otherClientOrder(sim, "BUY", 40); // the account holds 140
      sim.setFill({ kind: "delayed", afterMs: 60_000 });
      await otherClientOrder(sim, "SELL", 60); // open: adopted as an exit of ours
      await runSync(ctx);
      expect(
        ctx.sql.exec("SELECT kind, source FROM intents WHERE source = 'external'").toArray(),
      ).toEqual([{ kind: "exit", source: "external" }]);
      clock.now += 60_000;
      await runSync(ctx); // it filled: sold_qty 60, the account holds 80
      expect(positions(ctx)[0]).toMatchObject({ status: "OPEN", sold_qty: 60 });

      sim.setFill({ kind: "instant" });
      await allOut(ctx, id); // sells the remaining 40; 40 stay held by the other client
      await runSync(ctx);
      await runSync(ctx);
      expect(positions(ctx)[0]).toMatchObject({ status: "CLOSED", sold_qty: 100 });
      expect(positions(ctx).filter((position) => position.status !== "CLOSED")).toEqual([]);
    });
  });

  it("does not turn a purchase adopted before the hold into a position of ours", async () => {
    await scenario(async (ctx, sim, clock) => {
      const id = await openPosition(ctx, sim, 100);
      sim.setFill({ kind: "delayed", afterMs: 60_000 });
      await otherClientOrder(sim, "BUY", 40); // open while our position is, adopted as an external entry
      await runSync(ctx);
      sim.setFill({ kind: "instant" });
      await allOut(ctx, id);
      clock.now += 60_000; // the other client's purchase fills too
      await runSync(ctx);
      await runSync(ctx);
      await runSync(ctx);
      expect(positions(ctx).filter((position) => position.status !== "CLOSED")).toEqual([]);
      // While the hold lasts the waiting purchase takes no slot: nothing open, nothing reserved.
      expect(limitCounts(ctx)).toMatchObject({ open: 0, reservedOpens: 0 });
      expect(await openSecondEntry(ctx)).toBe(true);

      await otherClientOrder(sim, "SELL", 40); // flat again: nothing left for that entry to become
      await runSync(ctx);
      await runSync(ctx);
      expect(positions(ctx).filter((position) => position.status !== "CLOSED")).toEqual([]);
      // Dropped once flat: it takes no slot and cannot become a position when bought again.
      expect(ctx.sql.exec("SELECT id FROM intents WHERE source = 'external'").toArray()).toEqual(
        [],
      );
      await otherClientOrder(sim, "BUY", 25);
      await runSync(ctx);
      await runSync(ctx);
      expect(positions(ctx).filter((position) => position.status !== "CLOSED")).toMatchObject([
        { original_qty: 25, source: "external" },
      ]);
    });
  });

  it("does not adopt another client's new purchase of the symbol while the holding is shared", async () => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 100);
      await otherClientOrder(sim, "BUY", 40);
      await allOut(ctx, id);
      await runSync(ctx);
      await runSync(ctx);
      sim.setFill({ kind: "delayed", afterMs: 600_000 });
      await otherClientOrder(sim, "BUY", 25);
      await runSync(ctx);
      await runSync(ctx);
      expect(ctx.sql.exec("SELECT id FROM intents WHERE source = 'external'").toArray()).toEqual(
        [],
      );
      expect(positions(ctx).filter((position) => position.status !== "CLOSED")).toEqual([]);
    });
  });
});

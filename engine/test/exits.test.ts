import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { BrokerAdapterShape } from "../src/broker/adapter.ts";
import type { LocalSim } from "../src/broker/local-sim/sim.ts";
import { prepareEntry, sendEntry, type EntryContext } from "../src/entries.ts";
import { cancelIntent, exitPosition, type ExitResult } from "../src/exits.ts";
import { makeTradeStationAdapter } from "../src/tradestation/adapter.ts";
import { runSync } from "../src/sync.ts";
import accountsFixture from "./fixtures/accounts.json";
import {
  IN_SESSION,
  inClient,
  newClient,
  newSim,
  type Client,
  type Clock,
} from "./sync-helpers.ts";
import { json, okToken, scriptedFetch } from "./tradestation/helpers.ts";

const ASK = 200;
const SATURDAY = Date.UTC(2026, 10, 7, 15, 0, 0);

/** Opens `symbol` with exactly `qty` shares: SIZE is ask x qty, the entry fills, a pass creates the position. */
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
  const row = ctx.sql
    .exec<{ id: string; original_qty: number }>(
      "SELECT id, original_qty FROM positions WHERE symbol = ? AND status != 'CLOSED'",
      symbol,
    )
    .one();
  expect(row.original_qty).toBe(qty);
  return row.id;
}

const exit = (ctx: EntryContext, positionId: string, step: number | "ALL_OUT") =>
  exitPosition(ctx, { mode: "SIM", positionId, step: step as 0 | "ALL_OUT" });

function qtyOf(result: Awaited<ReturnType<typeof exit>>): number {
  if (!result.ok) throw new Error(result.code);
  const value: ExitResult = result.value;
  if (value.status === "PLACED") return value.qty;
  if (value.status === "DONE_ZERO") return 0;
  throw new Error(`blocked: ${value.reasons.join()}`);
}

const steps = (ctx: EntryContext, positionId: string) =>
  ctx.sql
    .exec<{ state: string }>(
      "SELECT state FROM scaleout_steps WHERE position_id = ? ORDER BY idx",
      positionId,
    )
    .toArray()
    .map((row) => row.state);
const exitIntents = (ctx: EntryContext) =>
  ctx.sql
    .exec<{ id: string; qty: number; state: string; filled_qty: number }>(
      "SELECT id, qty, state, filled_qty FROM intents WHERE kind = 'exit' ORDER BY created_at, id",
    )
    .toArray();
const position = (ctx: EntryContext, id: string) =>
  ctx.sql
    .exec<{ sold_qty: number; status: string }>(
      "SELECT sold_qty, status FROM positions WHERE id = ?",
      id,
    )
    .one();

async function scenario(
  body: (ctx: EntryContext, sim: LocalSim, clock: Clock, client: Client) => Promise<void>,
  broker?: (sim: LocalSim) => BrokerAdapterShape,
) {
  const clock: Clock = { now: IN_SESSION };
  const sim = newSim(clock);
  const client = await newClient();
  await inClient(client, clock, broker?.(sim) ?? sim.adapter, (ctx) =>
    body(ctx, sim, clock, client),
  );
}

describe("scale-out steps", { timeout: 30_000 }, () => {
  it("sells the 7-contract sequence of the doc table: 2 / 2 / 0 / 1 / 1 / 0 / 1", async () => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 7);
      const sold: number[] = [];
      for (let step = 0; step < 7; step++) {
        sold.push(qtyOf(await exit(ctx, id, step)));
        await runSync(ctx);
      }
      expect(sold).toEqual([2, 2, 0, 1, 1, 0, 1]);
      expect(steps(ctx, id)).toEqual(
        Array(7)
          .fill("done")
          .map((s, i) => (i === 2 || i === 5 ? "done_zero" : s)),
      );
      expect(position(ctx, id)).toEqual({ sold_qty: 7, status: "CLOSED" });
    });
  });

  it.each([
    [50, [15, 10, 5, 5, 5, 5, 5]],
    [37, [11, 8, 3, 4, 4, 3, 4]],
    [137, [41, 28, 13, 14, 14, 13, 14]],
  ])("sells %i shares as the doc table says", async (original, expected) => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, original);
      const sold: number[] = [];
      for (let step = 0; step < 7; step++) {
        sold.push(qtyOf(await exit(ctx, id, step)));
        await runSync(ctx);
      }
      expect(sold).toEqual(expected);
    });
  });

  it("sends nothing for a step that rounds to zero and uses the step", async () => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 1);
      const result = await exit(ctx, id, 0);
      expect(result).toEqual({ ok: true, value: { status: "DONE_ZERO", step: 0 } });
      expect(exitIntents(ctx)).toEqual([]);
      expect(steps(ctx, id)[0]).toBe("done_zero");
      expect(await exit(ctx, id, 0)).toMatchObject({
        value: { status: "BLOCKED", reasons: ["STEP_NOT_AVAILABLE"] },
      });
    });
  });

  it("does not resend a pending step", async () => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 10);
      sim.setFill({ kind: "delayed", afterMs: 60_000 });
      expect(await exit(ctx, id, 0)).toMatchObject({ value: { status: "PLACED", qty: 3 } });
      expect(steps(ctx, id)[0]).toBe("pending");
      expect(await exit(ctx, id, 0)).toMatchObject({
        value: { status: "BLOCKED", reasons: ["STEP_NOT_AVAILABLE"] },
      });
      expect(exitIntents(ctx)).toHaveLength(1);
    });
  });

  it("gives a step back when the broker rejects the order after acknowledging it", async () => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 10);
      sim.setFill({ kind: "delayed", afterMs: 60_000 });
      sim.inject({ kind: "rejectAfterAck" });
      await exit(ctx, id, 0);
      await runSync(ctx);
      expect(exitIntents(ctx)[0]).toMatchObject({ state: "REJECTED" });
      expect(steps(ctx, id)[0]).toBe("available");
      expect(await exit(ctx, id, 0)).toMatchObject({ value: { status: "PLACED", qty: 3 } });
    });
  });

  it("gives a step back when the broker refuses the order outright, sending it once", async () => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 10);
      sim.inject({ kind: "rateLimited", operation: "placeOrder" });
      expect(await exit(ctx, id, 0)).toMatchObject({
        value: { status: "PLACED", state: "REJECTED" },
      });
      expect(steps(ctx, id)[0]).toBe("available");
      expect(position(ctx, id).sold_qty).toBe(0);
    });
  });

  it("gives a step back when a canceled order had no fill", async () => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 10);
      sim.setFill({ kind: "delayed", afterMs: 60_000 });
      const placed = await exit(ctx, id, 1);
      if (!placed.ok || placed.value.status !== "PLACED") throw new Error("not placed");
      const cancelled = await cancelIntent(ctx, { mode: "SIM", intentId: placed.value.intentId });
      expect(cancelled).toMatchObject({ value: { status: "REQUESTED", state: "CANCEL_PENDING" } });
      // Still pending: only a broker status ends it.
      expect(steps(ctx, id)[1]).toBe("pending");
      await runSync(ctx);
      expect(exitIntents(ctx)[0]).toMatchObject({ state: "CANCELED" });
      expect(steps(ctx, id)[1]).toBe("available");
    });
  });
});

describe("a step covered by open sells", () => {
  it("stays available instead of becoming done_zero, and sells again once the sells are canceled", async () => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 10);
      sim.setFill({ kind: "delayed", afterMs: 60_000 });
      const all = await exit(ctx, id, "ALL_OUT");
      if (!all.ok || all.value.status !== "PLACED") throw new Error("not placed");
      expect(await exit(ctx, id, 0)).toMatchObject({
        value: { status: "BLOCKED", reasons: ["NOTHING_AVAILABLE"] },
      });
      expect(steps(ctx, id)[0]).toBe("available");
      await cancelIntent(ctx, { mode: "SIM", intentId: all.value.intentId });
      await runSync(ctx);
      expect(await exit(ctx, id, 0)).toMatchObject({ value: { status: "PLACED", qty: 3 } });
    });
  });
});

describe("ALL OUT", () => {
  it("sells what is available, and the slot frees only when the broker reports nothing left", async () => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 10);
      sim.setFill({ kind: "delayed", afterMs: 60_000 });
      expect(qtyOf(await exit(ctx, id, "ALL_OUT"))).toBe(10);
      // Clicked, not filled: the position still holds its slot.
      expect(position(ctx, id).status).toBe("OPEN");
      await runSync(ctx);
      expect(position(ctx, id).status).toBe("OPEN");
      expect(await exit(ctx, id, "ALL_OUT")).toMatchObject({
        value: { status: "BLOCKED", reasons: ["NOTHING_AVAILABLE"] },
      });
    });
  });

  it("closes the position after the fill is reconciled", async () => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 10);
      await exit(ctx, id, "ALL_OUT");
      await runSync(ctx);
      expect(position(ctx, id)).toEqual({ sold_qty: 10, status: "CLOSED" });
    });
  });

  it("sells only what is not already committed after a partial fill", async () => {
    await scenario(async (ctx, sim, clock) => {
      const id = await openPosition(ctx, sim, 10);
      sim.setFill({ kind: "partial", qty: 1 });
      await exit(ctx, id, 0);
      await runSync(ctx);
      clock.now += 1;
      expect(position(ctx, id).sold_qty).toBe(1);
      // 3 asked, 1 filled: 2 still committed, so ALL OUT can sell 10 - 1 - 2 = 7.
      expect(qtyOf(await exit(ctx, id, "ALL_OUT"))).toBe(7);
    });
  });
});

describe("the sell ledger under concurrency", () => {
  it("never oversells when a step and ALL OUT race", async () => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 10);
      sim.setFill({ kind: "delayed", afterMs: 60_000 });
      const results = await Promise.all([
        exit(ctx, id, 0),
        exit(ctx, id, "ALL_OUT"),
        exit(ctx, id, 1),
        exit(ctx, id, "ALL_OUT"),
      ]);
      const placed = exitIntents(ctx).reduce((total, intent) => total + intent.qty, 0);
      expect(placed).toBeLessThanOrEqual(10);
      expect(results.filter((r) => r.ok && r.value.status === "PLACED").length).toBe(
        exitIntents(ctx).length,
      );
      // Whatever the order, the ledger is full: ALL OUT took everything the steps had not.
      expect(placed).toBe(10);
    });
  });

  it("lets only one of two simultaneous ALL OUTs through", async () => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 10);
      sim.setFill({ kind: "delayed", afterMs: 60_000 });
      const results = await Promise.all([exit(ctx, id, "ALL_OUT"), exit(ctx, id, "ALL_OUT")]);
      expect(exitIntents(ctx)).toHaveLength(1);
      expect(results.filter((r) => r.ok && r.value.status === "BLOCKED")).toHaveLength(1);
    });
  });
});

describe("uncertain outcomes", () => {
  it("marks a timeout UNKNOWN, holds the step and the quantity, and reconciles to the broker's order", async () => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 10);
      sim.inject({ kind: "dropPlaceResponse" });
      expect(await exit(ctx, id, 0)).toMatchObject({
        value: { status: "PLACED", state: "UNKNOWN" },
      });
      expect(steps(ctx, id)[0]).toBe("pending");
      // Nothing else can be sold from this position while the outcome is unknown.
      expect(await exit(ctx, id, "ALL_OUT")).toMatchObject({
        value: { status: "BLOCKED", reasons: ["UNKNOWN_INTENT_PENDING"] },
      });
      expect(await exit(ctx, id, 1)).toMatchObject({
        value: { status: "BLOCKED", reasons: ["UNKNOWN_INTENT_PENDING"] },
      });
      await runSync(ctx);
      expect(exitIntents(ctx)).toHaveLength(1);
      expect(exitIntents(ctx)[0]).toMatchObject({ state: "FILLED", filled_qty: 3 });
      expect(steps(ctx, id)[0]).toBe("done");
      expect(position(ctx, id).sold_qty).toBe(3);
    });
  });

  it("ends a cancel that raced a fill in the broker's state: filled, step done", async () => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 10);
      sim.setFill({ kind: "delayed", afterMs: 60_000 });
      const placed = await exit(ctx, id, 0);
      if (!placed.ok || placed.value.status !== "PLACED") throw new Error("not placed");
      sim.inject({ kind: "fillRacesCancel" });
      const cancelled = await cancelIntent(ctx, { mode: "SIM", intentId: placed.value.intentId });
      expect(cancelled).toMatchObject({ value: { state: "CANCEL_PENDING" } });
      await runSync(ctx);
      expect(exitIntents(ctx)[0]).toMatchObject({ state: "FILLED", filled_qty: 3 });
      expect(steps(ctx, id)[0]).toBe("done");
      expect(position(ctx, id).sold_qty).toBe(3);
    });
  });

  it("does not resend a cancel", async () => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 10);
      sim.setFill({ kind: "delayed", afterMs: 60_000 });
      const placed = await exit(ctx, id, 0);
      if (!placed.ok || placed.value.status !== "PLACED") throw new Error("not placed");
      const args = { mode: "SIM", intentId: placed.value.intentId } as const;
      await cancelIntent(ctx, args);
      expect(await cancelIntent(ctx, args)).toMatchObject({ value: { replay: true } });
    });
  });

  it("restores the order's state when the broker did not take the cancel", async () => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 10);
      sim.setFill({ kind: "delayed", afterMs: 60_000 });
      const placed = await exit(ctx, id, 0);
      if (!placed.ok || placed.value.status !== "PLACED") throw new Error("not placed");
      sim.inject({ kind: "rateLimited", operation: "cancelOrder" });
      const cancelled = await cancelIntent(ctx, { mode: "SIM", intentId: placed.value.intentId });
      expect(cancelled).toMatchObject({ value: { state: "ACKNOWLEDGED" } });
    });
  });

  it("refuses to cancel outside the session or while the position has an unknown order", async () => {
    await scenario(async (ctx, sim, clock) => {
      const id = await openPosition(ctx, sim, 10);
      sim.setFill({ kind: "delayed", afterMs: 60_000 });
      const placed = await exit(ctx, id, 0);
      if (!placed.ok || placed.value.status !== "PLACED") throw new Error("not placed");
      const args = { mode: "SIM", intentId: placed.value.intentId } as const;
      sim.inject({ kind: "dropPlaceResponse" });
      await exit(ctx, id, 1);
      expect(await cancelIntent(ctx, args)).toMatchObject({
        value: { status: "BLOCKED", reasons: ["UNKNOWN_INTENT_PENDING"] },
      });
      clock.now = SATURDAY;
      expect(await cancelIntent(ctx, args)).toMatchObject({
        value: { status: "BLOCKED", reasons: ["OUTSIDE_REGULAR_SESSION"] },
      });
      expect(exitIntents(ctx).find((intent) => intent.id === args.intentId)).toMatchObject({
        state: "ACKNOWLEDGED",
      });
    });
  });

  it("refuses to cancel what has no open order", async () => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 10);
      await exit(ctx, id, 0);
      await runSync(ctx);
      const filled = exitIntents(ctx)[0];
      expect(await cancelIntent(ctx, { mode: "SIM", intentId: filled?.id ?? "" })).toMatchObject({
        value: { status: "BLOCKED", reasons: ["NOT_CANCELABLE"] },
      });
      expect(await cancelIntent(ctx, { mode: "SIM", intentId: "nope" })).toMatchObject({
        value: { status: "BLOCKED", reasons: ["INTENT_NOT_FOUND"] },
      });
    });
  });
});

describe("what does not block an exit", () => {
  it("allows exits and cancels with both position slots taken and three entries used", async () => {
    await scenario(async (ctx, sim) => {
      const first = await openPosition(ctx, sim, 10, "AAPL");
      await openPosition(ctx, sim, 10, "MSFT");
      const counters = ctx.sql
        .exec<{ consumed: number }>("SELECT consumed FROM entry_counters")
        .one();
      ctx.sql.exec("UPDATE entry_counters SET consumed = 3");
      expect(counters.consumed).toBeGreaterThan(0);
      sim.setFill({ kind: "delayed", afterMs: 60_000 });
      const placed = await exit(ctx, first, 0);
      expect(placed).toMatchObject({ value: { status: "PLACED" } });
      if (!placed.ok || placed.value.status !== "PLACED") throw new Error("not placed");
      expect(
        await cancelIntent(ctx, { mode: "SIM", intentId: placed.value.intentId }),
      ).toMatchObject({ value: { status: "REQUESTED" } });
    });
  });

  it("is blocked outside the regular session", async () => {
    await scenario(async (ctx, sim, clock) => {
      const id = await openPosition(ctx, sim, 10);
      clock.now = SATURDAY;
      expect(await exit(ctx, id, 0)).toMatchObject({
        value: { status: "BLOCKED", reasons: ["OUTSIDE_REGULAR_SESSION"] },
      });
      expect(exitIntents(ctx)).toEqual([]);
      expect(steps(ctx, id)[0]).toBe("available");
    });
  });

  it("does not wait for a reconciliation hold", async () => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 10);
      sim.inject({ kind: "authExpired", operation: "orders" });
      await runSync(ctx);
      expect(await exit(ctx, id, "ALL_OUT")).toMatchObject({ value: { status: "PLACED" } });
    });
  });
});

describe("the SIM guard", () => {
  it("still refuses an unlisted account through the real adapter: the step is given back, nothing leaves", async () => {
    const script = scriptedFetch(() => json(accountsFixture));
    const made = makeTradeStationAdapter({
      mode: "SIM",
      accessToken: okToken,
      fetch: script.fetch,
      now: () => IN_SESSION,
    });
    if (!made.ok) throw new Error(made.reason);
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 10);
      // Data and the position from the simulation, placement through the real SIM adapter.
      const guarded: EntryContext = {
        ...ctx,
        broker: { ...sim.adapter, placeOrder: made.adapter.placeOrder },
      };
      expect(await exit(guarded, id, 0)).toMatchObject({
        value: { status: "PLACED", state: "REJECTED" },
      });
      expect(steps(ctx, id)[0]).toBe("available");
      expect(script.calls.filter((call) => call.method !== "GET")).toEqual([]);
      expect(
        script.calls.every((call) => call.url.startsWith("https://sim-api.tradestation.com/v3/")),
      ).toBe(true);
    });
  });
});

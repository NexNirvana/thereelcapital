import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { BrokerAdapterShape } from "../src/broker/adapter.ts";
import { Rejected, Unknown, type BrokerError } from "../src/broker/errors.ts";
import { prepareEntry, sendEntry, type EntryContext } from "../src/entries.ts";
import { runSync } from "../src/sync.ts";
import { IN_SESSION, inClient, newClient, newSim, type Clock } from "./sync-helpers.ts";

type Read = "orders" | "positions" | "historicalOrders";

const target = { mode: "SIM", accountId: "SIM-1", symbol: "AAPL", assetType: "equity" } as const;

async function enter(ctx: EntryContext) {
  const prepared = await prepareEntry(ctx, target);
  if (!prepared.ok || prepared.value.status !== "READY") throw new Error("not ready");
  await sendEntry(ctx, {
    ...target,
    intentId: prepared.value.intentId,
    confirmedQty: prepared.value.qty,
  });
}

/**
 * Delays each sync read, records when it starts and ends, and can make reads fail. With
 * `hideOrders` the orders listing is empty, so the intent's order is missing and the pass needs
 * the closed-order history too.
 */
function delayed(
  inner: BrokerAdapterShape,
  options: { failing?: readonly Read[]; hideOrders?: boolean } = {},
) {
  const timeline: string[] = [];
  const wrap =
    <Args extends unknown[], A>(name: Read, op: (...args: Args) => Effect.Effect<A, BrokerError>) =>
    (...args: Args) =>
      Effect.gen(function* () {
        timeline.push(`${name}:start`);
        yield* Effect.sleep(20);
        timeline.push(`${name}:end`);
        if (options.failing?.includes(name)) {
          return yield* Effect.fail(new Unknown({ operation: name, detail: "boom" }));
        }
        if (name === "orders" && options.hideOrders === true) return [] as never;
        return yield* op(...args);
      });
  const broker = {
    ...inner,
    orders: wrap("orders", inner.orders),
    positions: wrap("positions", inner.positions),
    historicalOrders: wrap("historicalOrders", inner.historicalOrders),
  } as BrokerAdapterShape;
  return { broker, timeline };
}

async function passWith(options: Parameters<typeof delayed>[1]) {
  const clock: Clock = { now: IN_SESSION };
  const sim = newSim(clock);
  sim.setFill({ kind: "instant" });
  const client = await newClient();
  await inClient(client, clock, sim.adapter, enter);
  const spy = delayed(sim.adapter, options);
  const events = await inClient(client, clock, spy.broker, async (ctx) => {
    await runSync(ctx);
    return ctx.sql
      .exec<{ data_json: string }>("SELECT data_json FROM events WHERE type = 'sync.broker_error'")
      .toArray();
  });
  return { timeline: spy.timeline, events };
}

describe("sync reads overlap", () => {
  it("starts positions and history together, only after the orders are in", async () => {
    const { timeline } = await passWith({ hideOrders: true });
    expect(timeline.slice(0, 2)).toEqual(["orders:start", "orders:end"]);
    expect(timeline.slice(2, 4).sort()).toEqual(["historicalOrders:start", "positions:start"]);
    expect(timeline.slice(4).sort()).toEqual(["historicalOrders:end", "positions:end"]);
  });

  it("without a missing order reads orders, then positions, and no history", async () => {
    const { timeline } = await passWith({});
    expect(timeline).toEqual(["orders:start", "orders:end", "positions:start", "positions:end"]);
  });

  it.each([
    [["orders", "positions", "historicalOrders"], "orders"],
    [["positions", "historicalOrders"], "positions"],
    [["historicalOrders"], "historicalOrders"],
  ] as const)("reports the first failure by precedence when %j fail", async (failing, reported) => {
    const { events } = await passWith({ failing, hideOrders: true });
    expect(events.map((row) => JSON.parse(row.data_json).operation)).toEqual([reported]);
  });
});

describe("the SIM account guard warm-up", () => {
  it("runs once per adapter with the client's accounts, beside the first orders read", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    const client = await newClient();
    const warmed: string[][] = [];
    const broker: BrokerAdapterShape = {
      ...sim.adapter,
      warmAccountGuard: (ids) => Effect.sync(() => void warmed.push([...ids])),
    };
    await inClient(client, clock, broker, async (ctx) => {
      await runSync(ctx);
      await runSync(ctx);
    });
    expect(warmed).toEqual([["SIM-1", "SIM-2"]]);
  });

  it("a failed warm-up changes nothing about the pass", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    const client = await newClient();
    const broker: BrokerAdapterShape = {
      ...sim.adapter,
      warmAccountGuard: () =>
        Effect.fail(new Rejected({ operation: "accounts", code: "X", reason: "no" })),
    };
    const result = await inClient(client, clock, broker, (ctx) => runSync(ctx));
    expect(result.reconciled).toBe(true);
  });
});

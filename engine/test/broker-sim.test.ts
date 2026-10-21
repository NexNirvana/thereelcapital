import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { BrokerAdapter, LOCAL_SIM_LABEL } from "../src/broker/adapter.ts";
import { localSimLayer } from "../src/broker/local-sim/sim.ts";
import {
  ACCOUNT,
  OTHER_ACCOUNT,
  T0,
  buy,
  failureOf,
  newSim,
  run,
  sell,
} from "./broker-fixtures.ts";

describe("local simulation: reads", () => {
  it("labels every account «simulación local»", async () => {
    const { adapter } = newSim();
    const accounts = await run(adapter.accounts());
    expect(adapter.source).toBe("local-sim");
    expect(accounts.map((a) => a.label)).toEqual([LOCAL_SIM_LABEL, LOCAL_SIM_LABEL]);
    expect(LOCAL_SIM_LABEL).toBe("simulación local");
    expect(accounts[1]).toMatchObject({ accountId: OTHER_ACCOUNT, kind: "Cash", active: true });
  });

  it("serves symbol details with option defaults", async () => {
    const { adapter } = newSim();
    expect(await run(adapter.symbolDetails("MSFT"))).toMatchObject({ pointValue: 1 });
    expect(await run(adapter.symbolDetails("MSFT 261120C400"))).toMatchObject({ pointValue: 100 });
    expect((await failureOf(adapter.symbolDetails("NOPE")))._tag).toBe("Rejected");
  });

  it("stamps quotes with the receive time and omits unknown symbols", async () => {
    const { adapter, clock } = newSim();
    clock.at += 5_000;
    const quotes = await run(adapter.quotes(["MSFT", "NOPE"]));
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({
      symbol: "MSFT",
      bid: 100_000_000,
      ask: 101_000_000,
      tradeTime: T0,
      receivedAt: T0 + 5_000,
      isDelayed: false,
      isHalted: false,
    });
  });

  it("derives expirations, strikes and the chain from the option contracts", async () => {
    const { adapter } = newSim();
    expect(await run(adapter.optionExpirations("MSFT"))).toEqual(["2026-11-20", "2026-12-18"]);
    expect(await run(adapter.optionStrikes("MSFT", "2026-11-20"))).toEqual([400_000_000]);
    const chain = await run(adapter.chainSnapshot("MSFT", "2026-11-20"));
    expect(chain.map((r) => [r.right, r.bid, r.ask])).toEqual([
      ["call", 3_000_000, 3_200_000],
      ["put", 2_000_000, 2_100_000],
    ]);
    expect((await failureOf(adapter.optionExpirations("AAPL")))._tag).toBe("Rejected");
  });

  it("is available as the BrokerAdapter service", async () => {
    const { sim } = newSim();
    const accounts = await Effect.runPromise(
      BrokerAdapter.use((broker) => broker.accounts()).pipe(Effect.provide(localSimLayer(sim))),
    );
    expect(accounts).toHaveLength(2);
  });
});

describe("local simulation: orders", () => {
  it("previews the price the order would fill at", async () => {
    const { adapter } = newSim();
    expect(await run(adapter.confirmOrder(buy("i-1")))).toEqual({
      orderConfirmId: "i-1",
      estimatedPriceMicros: 101_000_000,
    });
    expect(await run(adapter.orders([ACCOUNT]))).toEqual([]);
  });

  it("fills a MARKET buy at the ask and opens a position", async () => {
    const { adapter, clock } = newSim();
    clock.at += 1;
    const { orderId } = await run(adapter.placeOrder(buy("i-1", 10)));
    expect(orderId).toBe("t-1");
    const [order] = await run(adapter.orders([ACCOUNT]));
    expect(order).toMatchObject({
      orderId,
      orderConfirmId: "i-1",
      status: "FILLED",
      rawStatus: "FLL",
      quantity: 10,
      filledQty: 10,
      remainingQty: 0,
      avgFillPriceMicros: 101_000_000,
      openedAt: T0 + 1,
      closedAt: T0 + 1,
    });
    expect(await run(adapter.positions([ACCOUNT]))).toEqual([
      {
        accountId: ACCOUNT,
        symbol: "MSFT",
        assetType: "equity",
        quantity: 10,
        avgPriceMicros: 101_000_000,
      },
    ]);
  });

  it("averages entries with integer half-up rounding", async () => {
    const { sim, adapter } = newSim();
    await run(adapter.placeOrder(buy("i-1", 1)));
    sim.setQuote("MSFT", { ask: 102_000_001 });
    await run(adapter.placeOrder(buy("i-2", 2)));
    const [position] = await run(adapter.positions([ACCOUNT]));
    // (1 * 101.000000 + 2 * 102.000001) / 3 = 101.666667333...
    expect(position).toMatchObject({ quantity: 3, avgPriceMicros: 101_666_667 });
  });

  it("sells at the bid and closes the position", async () => {
    const { adapter } = newSim();
    await run(adapter.placeOrder(buy("i-1", 10)));
    await run(adapter.placeOrder(sell("i-2", 4)));
    expect(await run(adapter.positions([ACCOUNT]))).toMatchObject([{ quantity: 6 }]);
    const orders = await run(adapter.orders([ACCOUNT]));
    expect(orders[1]).toMatchObject({ avgFillPriceMicros: 100_000_000, status: "FILLED" });
    await run(adapter.placeOrder(sell("i-3", 6)));
    expect(await run(adapter.positions([ACCOUNT]))).toEqual([]);
  });

  it("rejects overselling, counting sells still working", async () => {
    const { sim, adapter } = newSim();
    await run(adapter.placeOrder(buy("i-1", 10)));
    expect(await failureOf(adapter.placeOrder(sell("i-2", 11)))).toMatchObject({
      _tag: "Rejected",
      code: "INSUFFICIENT_POSITION",
    });
    sim.setFill({ kind: "delayed", afterMs: 1_000 });
    await run(adapter.placeOrder(sell("i-3", 7)));
    expect(await failureOf(adapter.placeOrder(sell("i-4", 4)))).toMatchObject({
      code: "INSUFFICIENT_POSITION",
    });
  });

  it.each([
    ["an unknown account", { accountId: "NOPE" }, "UNKNOWN_ACCOUNT"],
    ["an unknown symbol", { symbol: "NOPE" }, "UNKNOWN_SYMBOL"],
    ["a zero quantity", { quantity: 0 }, "INVALID_QUANTITY"],
    ["a fractional quantity", { quantity: 1.5 }, "INVALID_QUANTITY"],
    ["an empty OrderConfirmID", { orderConfirmId: "" }, "INVALID_ORDER"],
    ["an option action on an equity", { tradeAction: "BUYTOOPEN" as const }, "INVALID_ORDER"],
  ])("rejects %s", async (_name, change, code) => {
    const { adapter } = newSim();
    expect(await failureOf(adapter.placeOrder({ ...buy("i-1"), ...change }))).toMatchObject({
      _tag: "Rejected",
      code,
    });
    expect(await run(adapter.orders([ACCOUNT]))).toEqual([]);
  });

  it("rejects a halted symbol and trades options with option actions", async () => {
    const { sim, adapter } = newSim();
    sim.setQuote("MSFT", { isHalted: true });
    expect(await failureOf(adapter.placeOrder(buy("i-1")))).toMatchObject({ code: "HALTED" });
    await run(
      adapter.placeOrder({
        accountId: ACCOUNT,
        symbol: "MSFT 261120C400",
        assetType: "option",
        tradeAction: "BUYTOOPEN",
        quantity: 2,
        orderConfirmId: "i-2",
      }),
    );
    expect(await run(adapter.positions([ACCOUNT]))).toMatchObject([
      { assetType: "option", quantity: 2, avgPriceMicros: 3_200_000 },
    ]);
  });

  it("returns the same order for a repeated OrderConfirmID", async () => {
    const { adapter } = newSim();
    const first = await run(adapter.placeOrder(buy("i-1", 10)));
    const again = await run(adapter.placeOrder(buy("i-1", 10)));
    expect(again).toEqual(first);
    expect(await run(adapter.orders([ACCOUNT]))).toHaveLength(1);
    expect(await run(adapter.positions([ACCOUNT]))).toMatchObject([{ quantity: 10 }]);
    const next = await run(adapter.placeOrder(buy("i-2", 10)));
    expect(next.orderId).not.toBe(first.orderId);
  });

  it("scopes orders and positions to the requested accounts", async () => {
    const { adapter } = newSim();
    await run(adapter.placeOrder(buy("i-1")));
    expect(await run(adapter.orders([OTHER_ACCOUNT]))).toEqual([]);
    expect(await run(adapter.positions([OTHER_ACCOUNT]))).toEqual([]);
    expect(await failureOf(adapter.orders(["NOPE"]))).toMatchObject({ code: "UNKNOWN_ACCOUNT" });
  });
});

describe("local simulation: fills over time", () => {
  it("acknowledges a delayed fill now and fills it when the clock gets there", async () => {
    const { sim, adapter, clock } = newSim();
    sim.setFill({ kind: "delayed", afterMs: 2_000 });
    await run(adapter.placeOrder(buy("i-1", 10)));
    expect(await run(adapter.orders([ACCOUNT]))).toMatchObject([
      { status: "ACKNOWLEDGED", rawStatus: "ACK", filledQty: 0, remainingQty: 10, closedAt: null },
    ]);
    expect(await run(adapter.positions([ACCOUNT]))).toEqual([]);
    clock.at += 1_999;
    expect(await run(adapter.orders([ACCOUNT]))).toMatchObject([{ status: "ACKNOWLEDGED" }]);
    clock.at += 1;
    expect(await run(adapter.orders([ACCOUNT]))).toMatchObject([
      { status: "FILLED", filledQty: 10, closedAt: T0 + 2_000 },
    ]);
  });

  it("fills part now and the rest later, with integer quantities", async () => {
    const { sim, adapter, clock } = newSim();
    sim.setFill({ kind: "partial", qty: 3, completeAfterMs: 5_000 });
    await run(adapter.placeOrder(buy("i-1", 10)));
    expect(await run(adapter.orders([ACCOUNT]))).toMatchObject([
      { status: "PARTIAL", rawStatus: "FPR", filledQty: 3, remainingQty: 7, closedAt: null },
    ]);
    expect(await run(adapter.positions([ACCOUNT]))).toMatchObject([{ quantity: 3 }]);
    clock.at += 5_000;
    expect(await run(adapter.orders([ACCOUNT]))).toMatchObject([
      { status: "FILLED", filledQty: 10, remainingQty: 0 },
    ]);
    expect(await run(adapter.positions([ACCOUNT]))).toMatchObject([{ quantity: 10 }]);
  });

  it("leaves a partial order open when it never completes, and caps qty at the order size", async () => {
    const { sim, adapter, clock } = newSim();
    sim.setFill({ kind: "partial", qty: 4 });
    await run(adapter.placeOrder(buy("i-1", 10)));
    clock.at += 86_400_000;
    expect(await run(adapter.orders([ACCOUNT]))).toMatchObject([
      { status: "PARTIAL", filledQty: 4 },
    ]);
    sim.setFill({ kind: "partial", qty: 99 });
    await run(adapter.placeOrder(buy("i-2", 5)));
    expect((await run(adapter.orders([ACCOUNT])))[1]).toMatchObject({
      status: "FILLED",
      filledQty: 5,
    });
  });
});

describe("local simulation: cancel and history", () => {
  it("cancels an open order and keeps what it already filled", async () => {
    const { sim, adapter, clock } = newSim();
    sim.setFill({ kind: "partial", qty: 3, completeAfterMs: 5_000 });
    const { orderId } = await run(adapter.placeOrder(buy("i-1", 10)));
    clock.at += 1_000;
    expect(await run(adapter.cancelOrder(ACCOUNT, orderId))).toEqual({ orderId });
    clock.at += 10_000;
    expect(await run(adapter.orders([ACCOUNT]))).toMatchObject([
      { status: "CANCELED", rawStatus: "CAN", filledQty: 3, remainingQty: 0, closedAt: T0 + 1_000 },
    ]);
    expect(await run(adapter.positions([ACCOUNT]))).toMatchObject([{ quantity: 3 }]);
  });

  it("refuses to cancel a filled order, an unknown one or another account's", async () => {
    const { adapter } = newSim();
    const { orderId } = await run(adapter.placeOrder(buy("i-1")));
    expect(await failureOf(adapter.cancelOrder(ACCOUNT, orderId))).toMatchObject({
      _tag: "Rejected",
      code: "ORDER_NOT_CANCELABLE",
    });
    expect(await failureOf(adapter.cancelOrder(ACCOUNT, "nope"))).toMatchObject({
      code: "ORDER_NOT_FOUND",
    });
    expect(await failureOf(adapter.cancelOrder(OTHER_ACCOUNT, orderId))).toMatchObject({
      code: "ORDER_NOT_FOUND",
    });
  });

  it("refuses to cancel twice", async () => {
    const { sim, adapter } = newSim();
    sim.setFill({ kind: "delayed", afterMs: 1_000 });
    const { orderId } = await run(adapter.placeOrder(buy("i-1")));
    await run(adapter.cancelOrder(ACCOUNT, orderId));
    expect(await failureOf(adapter.cancelOrder(ACCOUNT, orderId))).toMatchObject({
      code: "ORDER_NOT_CANCELABLE",
    });
  });

  it("lists only closed orders from `since` as history", async () => {
    const { sim, adapter, clock } = newSim();
    await run(adapter.placeOrder(buy("i-1")));
    clock.at += 10_000;
    sim.setFill({ kind: "delayed", afterMs: 1_000 });
    await run(adapter.placeOrder(buy("i-2")));
    const closedNow = await run(adapter.historicalOrders([ACCOUNT], T0));
    expect(closedNow.map((o) => o.orderConfirmId)).toEqual(["i-1"]);
    expect(await run(adapter.historicalOrders([ACCOUNT], T0 + 1))).toEqual([]);
  });
});

describe("local simulation: determinism", () => {
  it("replays the same script to the same result", async () => {
    const script = async () => {
      const { sim, adapter, clock } = newSim();
      sim.setFill({ kind: "partial", qty: 3, completeAfterMs: 500 });
      await run(adapter.placeOrder(buy("i-1", 10)));
      clock.at += 500;
      return {
        orders: await run(adapter.orders([ACCOUNT])),
        positions: await run(adapter.positions([ACCOUNT])),
      };
    };
    expect(await script()).toEqual(await script());
  });
});

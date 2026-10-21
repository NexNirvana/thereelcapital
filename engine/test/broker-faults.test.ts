import { describe, expect, it } from "vitest";
import { STALE_QUOTE_AGE_MS } from "../src/broker/local-sim/sim.ts";
import { ACCOUNT, T0, buy, failureOf, newSim, run } from "./broker-fixtures.ts";

describe("fault injection", () => {
  it("drops the response after place: the order exists, the caller gets Timeout", async () => {
    const { sim, adapter } = newSim();
    sim.inject({ kind: "dropPlaceResponse" });
    expect(await failureOf(adapter.placeOrder(buy("i-1", 10)))).toMatchObject({
      _tag: "Timeout",
      operation: "placeOrder",
    });
    // Reconciliation finds it by OrderConfirmID, and the position exists.
    expect(await run(adapter.orders([ACCOUNT]))).toMatchObject([
      { orderConfirmId: "i-1", status: "FILLED" },
    ]);
    expect(await run(adapter.positions([ACCOUNT]))).toMatchObject([{ quantity: 10 }]);
  });

  it("a resend after a dropped response does not duplicate the order", async () => {
    const { sim, adapter } = newSim();
    sim.inject({ kind: "dropPlaceResponse" });
    await failureOf(adapter.placeOrder(buy("i-1", 10)));
    const [existing] = await run(adapter.orders([ACCOUNT]));
    expect(await run(adapter.placeOrder(buy("i-1", 10)))).toEqual({ orderId: existing?.orderId });
    expect(await run(adapter.orders([ACCOUNT]))).toHaveLength(1);
    expect(await run(adapter.positions([ACCOUNT]))).toMatchObject([{ quantity: 10 }]);
  });

  it("does not spend the drop on a rejected place", async () => {
    const { sim, adapter } = newSim();
    sim.inject({ kind: "dropPlaceResponse" });
    expect(await failureOf(adapter.placeOrder(buy("i-1", 0)))).toMatchObject({ _tag: "Rejected" });
    expect(await failureOf(adapter.placeOrder(buy("i-2", 1)))).toMatchObject({ _tag: "Timeout" });
  });

  it("rejects after the ack: acknowledged first, REJECTED on the next read, no fill", async () => {
    const { sim, adapter, clock } = newSim();
    sim.inject({ kind: "rejectAfterAck" });
    const { orderId } = await run(adapter.placeOrder(buy("i-1", 10)));
    expect(orderId).toBe("t-1");
    clock.at += 100;
    expect(await run(adapter.orders([ACCOUNT]))).toMatchObject([
      { status: "REJECTED", rawStatus: "REJ", filledQty: 0, remainingQty: 0, closedAt: T0 + 100 },
    ]);
    expect(await run(adapter.positions([ACCOUNT]))).toEqual([]);
    expect(await run(adapter.historicalOrders([ACCOUNT], T0))).toHaveLength(1);
  });

  it("rejects after the ack even when the first read is the cancel", async () => {
    const { sim, adapter } = newSim();
    sim.inject({ kind: "rejectAfterAck" });
    const { orderId } = await run(adapter.placeOrder(buy("i-1", 10)));
    expect(await failureOf(adapter.cancelOrder(ACCOUNT, orderId))).toMatchObject({
      code: "ORDER_NOT_CANCELABLE",
    });
  });

  it("lets a fill win the race against a cancel", async () => {
    const { sim, adapter } = newSim();
    sim.setFill({ kind: "delayed", afterMs: 60_000 });
    const { orderId } = await run(adapter.placeOrder(buy("i-1", 10)));
    sim.inject({ kind: "fillRacesCancel" });
    expect(await failureOf(adapter.cancelOrder(ACCOUNT, orderId))).toMatchObject({
      _tag: "Rejected",
      code: "ORDER_NOT_CANCELABLE",
    });
    expect(await run(adapter.orders([ACCOUNT]))).toMatchObject([
      { status: "FILLED", filledQty: 10, remainingQty: 0 },
    ]);
    expect(await run(adapter.positions([ACCOUNT]))).toMatchObject([{ quantity: 10 }]);
  });

  it("fills only the unfilled part when a partial order loses the cancel race", async () => {
    const { sim, adapter } = newSim();
    sim.setFill({ kind: "partial", qty: 4 });
    const { orderId } = await run(adapter.placeOrder(buy("i-1", 10)));
    sim.inject({ kind: "fillRacesCancel" });
    await failureOf(adapter.cancelOrder(ACCOUNT, orderId));
    expect(await run(adapter.positions([ACCOUNT]))).toMatchObject([{ quantity: 10 }]);
  });

  it("leaves the fault queued while a cancel finds nothing to race", async () => {
    const { sim, adapter } = newSim();
    sim.inject({ kind: "fillRacesCancel" });
    expect(await failureOf(adapter.cancelOrder(ACCOUNT, "nope"))).toMatchObject({
      code: "ORDER_NOT_FOUND",
    });
    sim.setFill({ kind: "delayed", afterMs: 1_000 });
    const { orderId } = await run(adapter.placeOrder(buy("i-1", 10)));
    expect(await failureOf(adapter.cancelOrder(ACCOUNT, orderId))).toMatchObject({
      code: "ORDER_NOT_CANCELABLE",
    });
  });

  it("returns a stale quote once: delayed, with an old trade time", async () => {
    const { sim, adapter, clock } = newSim();
    clock.at += 1_000;
    sim.inject({ kind: "quoteStale", symbol: "MSFT" });
    const [stale] = await run(adapter.quotes(["MSFT"]));
    expect(stale).toMatchObject({
      isDelayed: true,
      tradeTime: T0 + 1_000 - STALE_QUOTE_AGE_MS,
      receivedAt: T0 + 1_000,
    });
    const [fresh] = await run(adapter.quotes(["MSFT"]));
    expect(fresh).toMatchObject({ isDelayed: false, tradeTime: T0 });
  });

  it("leaves a missing quote out once", async () => {
    const { sim, adapter } = newSim();
    sim.inject({ kind: "quoteMissing", symbol: "MSFT" });
    expect(await run(adapter.quotes(["MSFT", "MSFT 261120C400"]))).toMatchObject([
      { symbol: "MSFT 261120C400" },
    ]);
    expect(await run(adapter.quotes(["MSFT"]))).toHaveLength(1);
  });

  it("expires auth on the next call of any operation, then recovers", async () => {
    const { sim, adapter } = newSim();
    sim.inject({ kind: "authExpired" });
    expect(await failureOf(adapter.accounts())).toMatchObject({
      _tag: "AuthExpired",
      operation: "accounts",
    });
    expect(await run(adapter.accounts())).toHaveLength(2);
  });

  it("expires auth only on the named operation", async () => {
    const { sim, adapter } = newSim();
    sim.inject({ kind: "authExpired", operation: "placeOrder" });
    expect(await run(adapter.accounts())).toHaveLength(2);
    expect(await failureOf(adapter.placeOrder(buy("i-1")))).toMatchObject({ _tag: "AuthExpired" });
    expect(await run(adapter.orders([ACCOUNT]))).toEqual([]);
  });

  it("answers 429 with the retry hint, and without one", async () => {
    const { sim, adapter } = newSim();
    sim.inject({ kind: "rateLimited", operation: "quotes", retryAfterMs: 30_000 });
    sim.inject({ kind: "rateLimited", operation: "quotes" });
    expect(await failureOf(adapter.quotes(["MSFT"]))).toMatchObject({
      _tag: "RateLimited",
      retryAfterMs: 30_000,
    });
    expect(await failureOf(adapter.quotes(["MSFT"]))).toMatchObject({
      _tag: "RateLimited",
      retryAfterMs: null,
    });
    expect(await run(adapter.quotes(["MSFT"]))).toHaveLength(1);
  });

  it("changes nothing when a fault stops a place before the broker sees it", async () => {
    const { sim, adapter } = newSim();
    sim.inject({ kind: "rateLimited", operation: "placeOrder" });
    await failureOf(adapter.placeOrder(buy("i-1")));
    expect(await run(adapter.orders([ACCOUNT]))).toEqual([]);
    expect(await run(adapter.placeOrder(buy("i-1")))).toEqual({ orderId: "t-1" });
  });

  it("fires a fault `times` times, in the order injected", async () => {
    const { sim, adapter } = newSim();
    sim.inject({ kind: "authExpired" }, 2);
    sim.inject({ kind: "rateLimited" });
    expect((await failureOf(adapter.accounts()))._tag).toBe("AuthExpired");
    expect((await failureOf(adapter.accounts()))._tag).toBe("AuthExpired");
    expect((await failureOf(adapter.accounts()))._tag).toBe("RateLimited");
    expect(await run(adapter.accounts())).toHaveLength(2);
  });
});

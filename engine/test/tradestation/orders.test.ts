import { describe, expect, it } from "vitest";
import type { BrokerSkip } from "../../src/broker/adapter.ts";
import { makeTransport, type FetchFn } from "../../src/tradestation/http.ts";
import * as orders from "../../src/tradestation/orders.ts";
import { mapOrderStatus } from "../../src/tradestation/status.ts";
import ordersFixture from "../fixtures/orders.json";
import positionsFixture from "../fixtures/positions.json";
import { SIM_BASE, failureOf, json, okToken, run, scriptedFetch } from "./helpers.ts";

function withBody(body: unknown) {
  const script = scriptedFetch(() => json(body));
  const made = makeTransport({
    mode: "SIM",
    accessToken: okToken,
    fetch: script.fetch satisfies FetchFn,
    retryDelayMs: 0,
  });
  if (!made.ok) throw new Error(made.reason);
  return { transport: made.transport, calls: script.calls };
}

describe("status mapping", () => {
  it.each([
    ["ACK", "ACKNOWLEDGED"],
    ["OPN", "ACKNOWLEDGED"],
    ["DON", "ACKNOWLEDGED"],
    ["FPR", "PARTIAL"],
    ["FLL", "FILLED"],
    ["FLP", "FILLED"],
    ["CAN", "CANCELED"],
    ["EXP", "CANCELED"],
    ["UCH", "CANCELED"],
    ["TSC", "CANCELED"],
    ["OUT", "CANCELED"],
    ["REJ", "REJECTED"],
  ])("maps %s to %s", (raw, expected) => {
    expect(mapOrderStatus(raw)).toBe(expected);
  });

  it.each(["BRO", "RJC", "RJR", "SUS", "", "toString", "__proto__", "fll"])(
    "leaves %j unmapped",
    (raw) => {
      expect(mapOrderStatus(raw)).toBe("UNMAPPED");
    },
  );
});

describe("orders", () => {
  it("decodes the fixture and leaves out what the domain cannot represent", async () => {
    const { transport, calls } = withBody(ordersFixture);
    const result = await run(orders.orders(transport, ["123456782"]));
    expect(calls[0]?.url).toBe(`${SIM_BASE}/brokerage/accounts/123456782/orders`);
    // The two-leg order and the short sale are not representable and are not adopted.
    expect(result.map((o) => o.orderId)).toEqual([
      "286234131",
      "123456789",
      "286234140",
      "286234141",
      "286234144",
    ]);
    expect(result[0]).toEqual({
      orderId: "286234131",
      orderConfirmId: null,
      accountId: "123456782",
      symbol: "MSFT",
      tradeAction: "BUY",
      quantity: 10,
      filledQty: 4,
      remainingQty: 6,
      avgFillPriceMicros: 216_660_000,
      status: "PARTIAL",
      rawStatus: "FPR",
      openedAt: Date.parse("2021-02-24T15:47:45Z"),
      closedAt: null,
      rejectReason: null,
    });
    expect(result[1]).toMatchObject({
      status: "FILLED",
      filledQty: 10,
      closedAt: Date.parse("2020-11-16T16:53:37Z"),
    });
    expect(result[2]).toMatchObject({
      tradeAction: "SELLTOCLOSE",
      status: "CANCELED",
      symbol: "MSFT 211217P332.5",
    });
    expect(result[3]).toMatchObject({ status: "REJECTED", avgFillPriceMicros: null });
    expect(result[4]).toMatchObject({ status: "UNMAPPED", rawStatus: "BRO" });
  });

  it("batches account ids by ten", async () => {
    const { transport, calls } = withBody({ Orders: [] });
    const ids = Array.from({ length: 12 }, (_, i) => `A${i}`);
    await run(orders.orders(transport, ids));
    expect(calls.map((c) => c.url.split("/")[6])).toEqual([
      "A0,A1,A2,A3,A4,A5,A6,A7,A8,A9",
      "A10,A11",
    ]);
  });

  it("makes no request without accounts", async () => {
    const { transport, calls } = withBody({ Orders: [] });
    expect(await run(orders.orders(transport, []))).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("fails rather than return a partial answer when an account errors", async () => {
    const { transport } = withBody({
      Orders: [],
      Errors: [
        { AccountID: "A1", Error: "Forbidden", Message: "Request not supported for account type." },
      ],
    });
    expect(await failureOf(orders.orders(transport, ["A1"]))).toMatchObject({
      _tag: "Rejected",
      code: "Forbidden",
    });
  });

  it("fails rather than return a truncated list when the broker paginates", async () => {
    const { transport } = withBody({ Orders: [], NextToken: "abc" });
    expect(await failureOf(orders.orders(transport, ["A"]))).toMatchObject({ _tag: "Unknown" });
    const blank = withBody({ Orders: [], NextToken: "" });
    expect(await run(orders.orders(blank.transport, ["A"]))).toEqual([]);
  });

  it("leaves out an order it cannot read, names the field and keeps the others", async () => {
    const leg = {
      AssetType: "STOCK",
      BuyOrSell: "Buy",
      OpenOrClose: "Open",
      QuantityOrdered: "1",
      ExecQuantity: "0",
      QuantityRemaining: "1",
      Symbol: "MSFT",
    };
    const good = {
      OrderID: "9",
      AccountID: "A",
      Status: "OPN",
      OpenedDateTime: "2021-02-24T15:47:45Z",
      Legs: [leg],
    };
    const noTimestamp = { ...good, OrderID: "1", OpenedDateTime: null };
    const fractional = { ...good, OrderID: "2", Legs: [{ ...leg, QuantityOrdered: "1.5" }] };
    const noStatus = {
      OrderID: "3",
      AccountID: "A",
      Legs: [leg],
      OpenedDateTime: good.OpenedDateTime,
    };
    const noQuantity = { ...good, OrderID: "4", Legs: [{ ...leg, ExecQuantity: undefined }] };
    const notAnOrder = "garbage";
    const skipped: BrokerSkip[] = [];
    const { transport } = withBody({
      Orders: [noTimestamp, fractional, noStatus, noQuantity, notAnOrder, good],
    });
    const result = await run(orders.orders(transport, ["A"], skipped));
    expect(result.map((order) => order.orderId)).toEqual(["9"]);
    expect(skipped).toEqual([
      { operation: "orders", orderId: "1", accountId: "A", symbol: null, field: "OpenedDateTime" },
      { operation: "orders", orderId: "2", accountId: "A", symbol: null, field: "QuantityOrdered" },
      { operation: "orders", orderId: "3", accountId: "A", symbol: null, field: "Status" },
      {
        operation: "orders",
        orderId: "4",
        accountId: "A",
        symbol: null,
        field: "Legs.ExecQuantity",
      },
      { operation: "orders", orderId: null, accountId: null, symbol: null, field: "item" },
    ]);
    expect(JSON.stringify(skipped)).not.toContain("1.5");
  });

  it("keeps the broker's rejection reason, cut short", async () => {
    const order = {
      OrderID: "5",
      AccountID: "A",
      Status: "REJ",
      OpenedDateTime: "2021-02-24T15:47:45Z",
      RejectReason: "x".repeat(500),
      Legs: [
        {
          AssetType: "STOCKOPTION",
          BuyOrSell: "Sell",
          OpenOrClose: "Close",
          QuantityOrdered: "476",
          ExecQuantity: "0",
          QuantityRemaining: "476",
          Symbol: "F 261030C12",
        },
      ],
    };
    const [rejected] = await run(orders.orders(withBody({ Orders: [order] }).transport, ["A"]));
    expect(rejected).toMatchObject({ status: "REJECTED", tradeAction: "SELLTOCLOSE" });
    expect(rejected?.rejectReason).toHaveLength(200);
  });

  it("still fails the whole read when the answer itself is not a list of orders", async () => {
    const { transport } = withBody({ Orders: "nope" });
    expect(await failureOf(orders.orders(transport, ["A"]))).toMatchObject({
      _tag: "Unknown",
      detail: "invalid_response",
    });
  });
});

describe("historicalOrders", () => {
  it("asks since the UTC date and decodes like orders", async () => {
    const { transport, calls } = withBody(ordersFixture);
    const result = await run(
      orders.historicalOrders(transport, ["123456782"], Date.UTC(2026, 9, 1, 23, 30)),
    );
    expect(calls[0]?.url).toBe(
      `${SIM_BASE}/brokerage/accounts/123456782/historicalorders?since=2026-10-01`,
    );
    expect(result).toHaveLength(5);
  });
});

describe("positions", () => {
  it("decodes positions in micro-dollars without P&L, and reports a short as short", async () => {
    const { transport, calls } = withBody(positionsFixture);
    const result = await run(orders.positions(transport, ["123456782"]));
    expect(calls[0]?.url).toBe(`${SIM_BASE}/brokerage/accounts/123456782/positions`);
    expect(result).toEqual([
      {
        accountId: "123456782",
        symbol: "MSFT",
        assetType: "equity",
        side: "long",
        quantity: 10,
        avgPriceMicros: 216_680_000,
      },
      {
        accountId: "123456782",
        symbol: "MSFT 211217P332.5",
        assetType: "option",
        side: "long",
        quantity: 2,
        avgPriceMicros: 3_150_000,
      },
      {
        accountId: "123456782",
        symbol: "AAPL",
        assetType: "equity",
        side: "short",
        quantity: 5,
        avgPriceMicros: 50_000_000,
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Profit|MarketValue/);
  });

  it("fails when an account errors", async () => {
    const { transport } = withBody({
      Positions: [],
      Errors: [{ AccountID: "X", Error: "Forbidden" }],
    });
    expect(await failureOf(orders.positions(transport, ["X"]))).toMatchObject({ _tag: "Rejected" });
  });

  it("leaves out a position it cannot read and keeps the others", async () => {
    const good = {
      AccountID: "A",
      Symbol: "MSFT",
      AssetType: "STOCK",
      LongShort: "Long",
      Quantity: "10",
      AveragePrice: "1.5",
    };
    const skipped: BrokerSkip[] = [];
    const { transport } = withBody({
      Positions: [
        { ...good, Symbol: "F 261030C12", AssetType: "STOCKOPTION", AveragePrice: undefined },
        { ...good, Symbol: "IBM", Quantity: "1.5" },
        { ...good, Symbol: "KO", LongShort: "Flat" },
        good,
      ],
    });
    const result = await run(orders.positions(transport, ["A"], skipped));
    expect(result.map((position) => position.symbol)).toEqual(["MSFT"]);
    expect(skipped.map((item) => [item.symbol, item.field])).toEqual([
      ["F 261030C12", "AveragePrice"],
      ["IBM", "Quantity"],
      ["KO", "LongShort"],
    ]);
  });
});

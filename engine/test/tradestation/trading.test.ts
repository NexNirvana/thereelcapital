import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { BrokerAdapter, type OrderRequest } from "../../src/broker/adapter.ts";
import {
  SimOnlyRefused,
  makeTradeStationAdapter,
  tradeStationLayer,
  type TradeStationAdapterConfig,
} from "../../src/tradestation/adapter.ts";
import type { FetchFn } from "../../src/tradestation/http.ts";
import accountsFixture from "../fixtures/accounts.json";
import cancelFixture from "../fixtures/cancel.json";
import confirmFixture from "../fixtures/confirm.json";
import placeFixture from "../fixtures/place.json";
import placeRefused from "../fixtures/place-refused.json";
import { SIM_BASE, failureOf, json, okToken, run, scriptedFetch } from "./helpers.ts";

const ACCOUNT = "123456782";
const request: OrderRequest = {
  accountId: ACCOUNT,
  symbol: "MSFT",
  assetType: "equity",
  tradeAction: "BUY",
  quantity: 10,
  orderConfirmId: "7CMygnFJXk-ihrJJfOPmVQ",
};

/** Answers /brokerage/accounts with the fixture and every other call with `respond`. */
function adapterWith(
  respond: () => Response | Promise<Response>,
  accountsBody: unknown = accountsFixture,
  overrides: Partial<TradeStationAdapterConfig> = {},
) {
  const script = scriptedFetch(() => json({}));
  const fetchFn: FetchFn = (url, init) =>
    url.endsWith("/brokerage/accounts")
      ? (script.fetch(url, init), Promise.resolve(json(accountsBody)))
      : (script.fetch(url, init), Promise.resolve().then(respond));
  const made = makeTradeStationAdapter({
    mode: "SIM",
    accessToken: okToken,
    fetch: fetchFn,
    retryDelayMs: 0,
    now: () => 1_800_000_000_000,
    ...overrides,
  });
  if (!made.ok) throw new Error(made.reason);
  return { adapter: made.adapter, calls: script.calls };
}
const mutations = (calls: ReturnType<typeof adapterWith>["calls"]) =>
  calls.filter((call) => call.method !== "GET");

describe("construction refuses anything but SIM", () => {
  const base = { accessToken: okToken, now: () => 0 };

  it("refuses REAL mode without building an adapter", () => {
    expect(makeTradeStationAdapter({ ...base, mode: "REAL" })).toEqual({
      ok: false,
      reason: "MODE_NOT_SIM",
    });
  });

  it("refuses a base URL that is not the SIM host", () => {
    expect(
      makeTradeStationAdapter({ ...base, mode: "SIM", baseUrl: "https://example.com/v3" }),
    ).toEqual({ ok: false, reason: "BASE_URL_NOT_SIM" });
  });

  it("makes the layer fail with SimOnlyRefused", async () => {
    const layer = tradeStationLayer({ ...base, mode: "REAL" });
    const program = Effect.gen(function* () {
      return yield* BrokerAdapter;
    }).pipe(Effect.provide(layer), Effect.flip);
    expect(await Effect.runPromise(program)).toEqual(
      new SimOnlyRefused({ reason: "MODE_NOT_SIM" }),
    );
  });

  it("provides the adapter through the layer for SIM", async () => {
    const script = scriptedFetch(() => json(accountsFixture));
    const layer = tradeStationLayer({ ...base, mode: "SIM", fetch: script.fetch });
    const accounts = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* BrokerAdapter;
        expect(adapter.source).toBe("tradestation-sim");
        return yield* adapter.accounts();
      }).pipe(Effect.provide(layer)),
    );
    expect(accounts).toHaveLength(3);
  });
});

describe("confirmOrder", () => {
  it("previews a MARKET order without sending the OrderConfirmID", async () => {
    const { adapter, calls } = adapterWith(() => json(confirmFixture));
    expect(await run(adapter.confirmOrder(request))).toEqual({
      orderConfirmId: request.orderConfirmId,
      estimatedPriceMicros: 216_320_000,
    });
    const sent = mutations(calls);
    expect(sent[0]?.url).toBe(`${SIM_BASE}/orderexecution/orderconfirm`);
    expect(JSON.parse(sent[0]?.body ?? "null")).toEqual({
      AccountID: ACCOUNT,
      Symbol: "MSFT",
      Quantity: "10",
      OrderType: "Market",
      TradeAction: "BUY",
      TimeInForce: { Duration: "DAY" },
      Route: "Intelligent",
    });
  });
});

describe("placeOrder", () => {
  it("sends exactly MARKET + DAY + OrderConfirmID to the SIM host and returns the OrderID", async () => {
    const { adapter, calls } = adapterWith(() => json(placeFixture));
    expect(await run(adapter.placeOrder(request))).toEqual({ orderId: "286179831" });
    const sent = mutations(calls);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: "POST", url: `${SIM_BASE}/orderexecution/orders` });
    expect(JSON.parse(sent[0]?.body ?? "null")).toEqual({
      AccountID: ACCOUNT,
      Symbol: "MSFT",
      Quantity: "10",
      OrderType: "Market",
      TradeAction: "BUY",
      TimeInForce: { Duration: "DAY" },
      Route: "Intelligent",
      OrderConfirmID: request.orderConfirmId,
    });
  });

  it("sends option actions for options", async () => {
    const { adapter, calls } = adapterWith(() => json(placeFixture));
    await run(
      adapter.placeOrder({
        ...request,
        symbol: "MSFT 211217P332.5",
        assetType: "option",
        tradeAction: "BUYTOOPEN",
      }),
    );
    expect(JSON.parse(mutations(calls)[0]?.body ?? "null")).toMatchObject({
      TradeAction: "BUYTOOPEN",
    });
  });

  it("treats HTTP 200 with only Errors as Rejected", async () => {
    const { adapter } = adapterWith(() => json(placeRefused));
    expect(await failureOf(adapter.placeOrder(request))).toMatchObject({
      _tag: "Rejected",
      code: "FAILED",
    });
  });

  it("maps a 4xx order rejection to Rejected", async () => {
    const { adapter } = adapterWith(() =>
      json({ Error: "BadRequest", Message: "Invalid symbol" }, 400),
    );
    expect(await failureOf(adapter.placeOrder(request))).toMatchObject({
      _tag: "Rejected",
      code: "BadRequest",
    });
  });

  it("maps 401 and 429 to AuthExpired and RateLimited", async () => {
    expect(
      await failureOf(adapterWith(() => json({}, 401)).adapter.placeOrder(request)),
    ).toMatchObject({ _tag: "AuthExpired" });
    expect(
      await failureOf(
        adapterWith(() => json({}, 429, { "x-ratelimit-reset": "30" })).adapter.placeOrder(request),
      ),
    ).toMatchObject({ _tag: "RateLimited", retryAfterMs: 30_000 });
  });

  it("is not understood, so Unknown, when 200 carries neither an order nor an error", async () => {
    const { adapter } = adapterWith(() => json({ Orders: [{ Message: "?" }] }));
    expect(await failureOf(adapter.placeOrder(request))).toMatchObject({ _tag: "Unknown" });
  });

  it("never retries: a timeout is Timeout after exactly one POST", async () => {
    const { adapter, calls } = adapterWith(() => {
      throw new DOMException("", "TimeoutError");
    });
    expect(await failureOf(adapter.placeOrder(request))).toMatchObject({ _tag: "Timeout" });
    expect(mutations(calls)).toHaveLength(1);
  });

  it("never retries a 5xx or a dropped connection", async () => {
    const fiveHundred = adapterWith(() => json({}, 503));
    expect(await failureOf(fiveHundred.adapter.placeOrder(request))).toMatchObject({
      _tag: "Unknown",
    });
    expect(mutations(fiveHundred.calls)).toHaveLength(1);
    const dropped = adapterWith(() => {
      throw new TypeError("reset");
    });
    expect(await failureOf(dropped.adapter.placeOrder(request))).toMatchObject({ _tag: "Unknown" });
    expect(mutations(dropped.calls)).toHaveLength(1);
  });

  it.each([
    [
      "an OrderConfirmID over 22 characters",
      { orderConfirmId: "x".repeat(23) },
      "INVALID_ORDER_CONFIRM_ID",
    ],
    ["an empty OrderConfirmID", { orderConfirmId: "" }, "INVALID_ORDER_CONFIRM_ID"],
    ["a zero quantity", { quantity: 0 }, "INVALID_QUANTITY"],
    ["a fractional quantity", { quantity: 1.5 }, "INVALID_QUANTITY"],
    [
      "an option action on an equity",
      { tradeAction: "BUYTOOPEN" as const },
      "TRADE_ACTION_MISMATCH",
    ],
    ["an equity action on an option", { assetType: "option" as const }, "TRADE_ACTION_MISMATCH"],
  ])("refuses %s without sending anything", async (_name, change, code) => {
    const { adapter, calls } = adapterWith(() => json(placeFixture));
    expect(await failureOf(adapter.placeOrder({ ...request, ...change }))).toMatchObject({
      _tag: "Rejected",
      code,
    });
    expect(calls).toHaveLength(0);
  });
});

describe("the SIM account guard", () => {
  it("lists accounts through the SIM host once, then reuses the answer", async () => {
    const { adapter, calls } = adapterWith(() => json(placeFixture));
    await run(adapter.placeOrder(request));
    await run(adapter.placeOrder({ ...request, orderConfirmId: "second" }));
    expect(calls.filter((call) => call.url.endsWith("/brokerage/accounts"))).toHaveLength(1);
    expect(mutations(calls)).toHaveLength(2);
  });

  it("makes no accounts call on the first order when the sync warmed it", async () => {
    const { adapter, calls } = adapterWith(() => json(placeFixture));
    await run(adapter.warmAccountGuard?.([ACCOUNT]) ?? Effect.void);
    const warmCalls = calls.length;
    await run(adapter.placeOrder(request));
    expect(
      calls.slice(warmCalls).filter((call) => call.url.endsWith("/brokerage/accounts")),
    ).toHaveLength(0);
    expect(mutations(calls)).toHaveLength(1);
  });

  it("still checks before sending when the warm-up did not happen or found no such account", async () => {
    const cold = adapterWith(() => json(placeFixture));
    await run(cold.adapter.placeOrder(request));
    expect(cold.calls.filter((call) => call.url.endsWith("/brokerage/accounts"))).toHaveLength(1);

    const { adapter, calls } = adapterWith(() => json(placeFixture));
    await failureOf(adapter.warmAccountGuard?.(["11111111"]) ?? Effect.void);
    expect(
      await failureOf(adapter.placeOrder({ ...request, accountId: "11111111" })),
    ).toMatchObject({
      code: "ACCOUNT_NOT_SIM",
    });
    expect(mutations(calls)).toHaveLength(0);
  });

  it("refuses an account the SIM API did not list, and sends no order", async () => {
    const { adapter, calls } = adapterWith(() => json(placeFixture));
    expect(
      await failureOf(adapter.placeOrder({ ...request, accountId: "11111111" })),
    ).toMatchObject({
      _tag: "Rejected",
      code: "ACCOUNT_NOT_SIM",
    });
    expect(mutations(calls)).toHaveLength(0);
    expect(calls.map((call) => call.url)).toEqual([`${SIM_BASE}/brokerage/accounts`]);
  });

  it("refuses listed accounts that cannot trade: Futures and inactive", async () => {
    const accountsBody = {
      Accounts: [
        { AccountID: "F1", AccountType: "Futures", Status: "Active" },
        { AccountID: "C1", AccountType: "Cash", Status: "Closed" },
      ],
    };
    const { adapter, calls } = adapterWith(() => json(placeFixture), accountsBody);
    for (const accountId of ["F1", "C1"]) {
      expect(await failureOf(adapter.placeOrder({ ...request, accountId }))).toMatchObject({
        code: "ACCOUNT_NOT_SIM",
      });
      expect(await failureOf(adapter.confirmOrder({ ...request, accountId }))).toMatchObject({
        code: "ACCOUNT_NOT_SIM",
      });
      expect(await failureOf(adapter.cancelOrder(accountId, "123"))).toMatchObject({
        code: "ACCOUNT_NOT_SIM",
      });
    }
    expect(mutations(calls)).toHaveLength(0);
  });

  it("sends no order when the account listing itself fails", async () => {
    const script = scriptedFetch(() => json({}, 401));
    const made = makeTradeStationAdapter({
      mode: "SIM",
      accessToken: okToken,
      fetch: script.fetch,
      retryDelayMs: 0,
      now: () => 0,
    });
    if (!made.ok) throw new Error(made.reason);
    expect(await failureOf(made.adapter.placeOrder(request))).toMatchObject({
      _tag: "AuthExpired",
    });
    expect(mutations(script.calls)).toHaveLength(0);
  });
});

describe("cancelOrder", () => {
  it("sends DELETE to the SIM host and returns the OrderID", async () => {
    const { adapter, calls } = adapterWith(() => json(cancelFixture));
    expect(await run(adapter.cancelOrder(ACCOUNT, "123456789"))).toEqual({ orderId: "123456789" });
    expect(mutations(calls)).toEqual([
      expect.objectContaining({
        method: "DELETE",
        url: `${SIM_BASE}/orderexecution/orders/123456789`,
      }),
    ]);
  });

  it.each(["1-2345-6789", "../positions", "12 3", "", "1/2"])(
    "refuses the order id %j without sending anything",
    async (orderId) => {
      const { adapter, calls } = adapterWith(() => json(cancelFixture));
      expect(await failureOf(adapter.cancelOrder(ACCOUNT, orderId))).toMatchObject({
        _tag: "Rejected",
        code: "INVALID_ORDER_ID",
      });
      expect(calls).toHaveLength(0);
    },
  );

  it("maps a refusal in a 200 body and a 4xx to Rejected", async () => {
    const refused = adapterWith(() => json({ Error: "FAILED", Message: "Order already filled" }));
    expect(await failureOf(refused.adapter.cancelOrder(ACCOUNT, "1"))).toMatchObject({
      _tag: "Rejected",
      code: "FAILED",
    });
    const fourHundred = adapterWith(() => json({ Error: "NotFound" }, 404));
    expect(await failureOf(fourHundred.adapter.cancelOrder(ACCOUNT, "1"))).toMatchObject({
      _tag: "Rejected",
      code: "NotFound",
    });
  });

  it("never retries: a timeout or 5xx is one DELETE", async () => {
    const timeout = adapterWith(() => {
      throw new DOMException("", "TimeoutError");
    });
    expect(await failureOf(timeout.adapter.cancelOrder(ACCOUNT, "1"))).toMatchObject({
      _tag: "Timeout",
    });
    expect(mutations(timeout.calls)).toHaveLength(1);
    const fiveHundred = adapterWith(() => json({}, 502));
    expect(await failureOf(fiveHundred.adapter.cancelOrder(ACCOUNT, "1"))).toMatchObject({
      _tag: "Unknown",
    });
    expect(mutations(fiveHundred.calls)).toHaveLength(1);
  });
});

describe("whole adapter", () => {
  it("only ever calls the SIM host", async () => {
    const { adapter, calls } = adapterWith(() => json(placeFixture));
    await run(adapter.accounts());
    await run(adapter.placeOrder(request));
    await failureOf(adapter.symbolDetails("MSFT"));
    await run(adapter.orders([ACCOUNT])); // shapes it cannot read are skipped, not fatal
    expect(calls.length).toBeGreaterThan(3);
    for (const call of calls) expect(call.url.startsWith(`${SIM_BASE}/`)).toBe(true);
  });
});

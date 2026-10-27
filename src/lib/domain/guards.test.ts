import { describe, expect, test } from "bun:test";
import {
  canReserveEntry,
  DEFAULT_DAILY_ENTRIES,
  isValidDailyEntries,
  canReserveSlot,
  checkOrder,
  type OrderContext,
  type OrderRequest,
  type RejectionReason,
} from "./guards";

// Tuesday 2026-10-20, 11:00 ET: inside the regular session.
const openNow = new Date("2026-10-20T15:00:00Z");
// Same day, 08:00 ET: before the open.
const beforeOpen = new Date("2026-10-20T12:00:00Z");

const equityBuy: OrderRequest = {
  mode: "SIM",
  accountId: "SIM1",
  instrument: { kind: "equity", symbol: "AAPL" },
  orderType: "Market",
  tradeAction: "BUY",
  quantity: 10,
};
const optionBuy: OrderRequest = {
  ...equityBuy,
  instrument: { kind: "option", symbol: "AAPL 261120C200", legs: 1 },
  tradeAction: "BUYTOOPEN",
};
const context: OrderContext = {
  clientId: "c1",
  account: { id: "SIM1", clientId: "c1", type: "Margin", active: true },
  available: 10,
  openSymbols: [],
  now: openNow,
};

function rejection(request: OrderRequest, ctx: OrderContext = context): RejectionReason | null {
  const result = checkOrder(request, ctx);
  return result.ok ? null : result.reason;
}

describe("checkOrder", () => {
  test("accepts an equity buy", () => {
    expect(checkOrder(equityBuy, context)).toEqual({ ok: true });
  });

  test("accepts a single-leg option buy to open", () => {
    expect(checkOrder(optionBuy, context)).toEqual({ ok: true });
  });

  test("rejects a mode that is not SIM", () => {
    expect(rejection({ ...equityBuy, mode: "REAL" })).toBe("MODE_NOT_SIM");
  });

  test("rejects an account of another client", () => {
    const other = { ...context, account: { ...context.account, clientId: "c2" } };
    expect(rejection(equityBuy, other)).toBe("ACCOUNT_NOT_OWNED");
  });

  test("rejects an account id that differs from the request", () => {
    expect(rejection({ ...equityBuy, accountId: "SIM2" })).toBe("ACCOUNT_NOT_OWNED");
  });

  test("rejects an inactive account", () => {
    const inactive = { ...context, account: { ...context.account, active: false } };
    expect(rejection(equityBuy, inactive)).toBe("ACCOUNT_NOT_ACTIVE");
  });

  test("rejects an account that is not Cash or Margin", () => {
    const futures = { ...context, account: { ...context.account, type: "Futures" } };
    expect(rejection(equityBuy, futures)).toBe("ACCOUNT_TYPE_NOT_ALLOWED");
  });

  test("rejects futures, spreads and multi-leg options", () => {
    for (const instrument of [
      { kind: "future", symbol: "ESZ26" },
      { kind: "spread", symbol: "AAPL SPREAD" },
      { kind: "option", symbol: "AAPL 261120C200", legs: 2 },
    ] as const) {
      expect(rejection({ ...equityBuy, instrument })).toBe("INSTRUMENT_OUT_OF_SCOPE");
    }
  });

  test("rejects an order type other than Market", () => {
    expect(rejection({ ...equityBuy, orderType: "Limit" })).toBe("ORDER_TYPE_NOT_MARKET");
  });

  test("rejects option actions on equities and equity actions on options", () => {
    expect(rejection({ ...equityBuy, tradeAction: "BUYTOOPEN" })).toBe("TRADE_ACTION_NOT_ALLOWED");
    expect(rejection({ ...optionBuy, tradeAction: "BUY" })).toBe("TRADE_ACTION_NOT_ALLOWED");
    expect(rejection({ ...equityBuy, tradeAction: "SELLSHORT" })).toBe("TRADE_ACTION_NOT_ALLOWED");
  });

  test("rejects a quantity that is not a positive safe integer", () => {
    for (const quantity of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(rejection({ ...equityBuy, tradeAction: "SELL", quantity })).toBe("QUANTITY_INVALID");
      expect(rejection({ ...equityBuy, quantity })).toBe("QUANTITY_INVALID");
    }
    expect(checkOrder({ ...equityBuy, quantity: Number.MAX_SAFE_INTEGER }, context)).toEqual({
      ok: true,
    });
    expect(checkOrder({ ...equityBuy, tradeAction: "SELL", quantity: 1 }, context)).toEqual({
      ok: true,
    });
  });

  test("rejects a sell above the available quantity", () => {
    const sell = { ...equityBuy, tradeAction: "SELL", quantity: 11 };
    expect(rejection(sell)).toBe("SELL_EXCEEDS_AVAILABLE");
    expect(checkOrder({ ...sell, quantity: 10 }, context)).toEqual({ ok: true });
  });

  test("rejects an order outside the regular session", () => {
    expect(rejection(equityBuy, { ...context, now: beforeOpen })).toBe("OUTSIDE_REGULAR_SESSION");
  });

  test("rejects an opening buy on a symbol that already has a position", () => {
    const held = { ...context, openSymbols: ["AAPL"] };
    expect(rejection(equityBuy, held)).toBe("POSITION_ALREADY_OPEN");
  });

  test("still allows selling a symbol that has an open position", () => {
    const held = { ...context, openSymbols: ["AAPL"] };
    expect(checkOrder({ ...equityBuy, tradeAction: "SELL" }, held)).toEqual({ ok: true });
  });
});

describe("entry and slot limits", () => {
  test("allows entries below 3 consumed plus reserved", () => {
    expect(canReserveEntry({ consumed: 1, reserved: 1 }, DEFAULT_DAILY_ENTRIES)).toBe(true);
  });

  test("rejects a fourth entry", () => {
    expect(canReserveEntry({ consumed: 2, reserved: 1 }, DEFAULT_DAILY_ENTRIES)).toBe(false);
    expect(canReserveEntry({ consumed: 3, reserved: 0 }, DEFAULT_DAILY_ENTRIES)).toBe(false);
  });

  test("follows a client's own daily limit", () => {
    expect(canReserveEntry({ consumed: 3, reserved: 0 }, 5)).toBe(true);
    expect(canReserveEntry({ consumed: 4, reserved: 0 }, 5)).toBe(true);
    expect(canReserveEntry({ consumed: 4, reserved: 1 }, 5)).toBe(false);
    expect(canReserveEntry({ consumed: 999, reserved: 0 }, 1000)).toBe(true);
    expect(canReserveEntry({ consumed: 0, reserved: 0 }, 1)).toBe(true);
    expect(canReserveEntry({ consumed: 1, reserved: 0 }, 1)).toBe(false);
    // A lower limit than the default blocks sooner.
    expect(canReserveEntry({ consumed: 2, reserved: 0 }, 2)).toBe(false);
  });

  test("accepts only whole daily limits from 1 to 1000", () => {
    for (const ok of [1, 3, 1000]) expect(isValidDailyEntries(ok)).toBe(true);
    for (const bad of [0, -1, 1001, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isValidDailyEntries(bad)).toBe(false);
    }
  });

  test("allows a slot below 2 open plus reserved", () => {
    expect(canReserveSlot({ open: 1, reservedOpens: 0 })).toBe(true);
  });

  test("rejects a third slot", () => {
    expect(canReserveSlot({ open: 1, reservedOpens: 1 })).toBe(false);
    expect(canReserveSlot({ open: 2, reservedOpens: 0 })).toBe(false);
  });

  test("never rejects exits because of the entry or slot limits", () => {
    // checkOrder takes no counters: at 3/3 entries and 2/2 slots a sell still passes.
    expect(canReserveEntry({ consumed: 3, reserved: 0 }, DEFAULT_DAILY_ENTRIES)).toBe(false);
    expect(canReserveSlot({ open: 2, reservedOpens: 0 })).toBe(false);
    const exit = { ...equityBuy, tradeAction: "SELL" };
    expect(checkOrder(exit, { ...context, openSymbols: ["AAPL"] })).toEqual({ ok: true });
    const optionExit = { ...optionBuy, tradeAction: "SELLTOCLOSE" };
    expect(
      checkOrder(optionExit, { ...context, openSymbols: [optionBuy.instrument.symbol] }),
    ).toEqual({ ok: true });
  });
});

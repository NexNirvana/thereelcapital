import { describe, expect, it } from "vitest";
import { makeTransport } from "../../src/tradestation/http.ts";
import * as market from "../../src/tradestation/market.ts";
import accountsFixture from "../fixtures/accounts.json";
import expirationsFixture from "../fixtures/expirations.json";
import quotesFixture from "../fixtures/quotes.json";
import strikesFixture from "../fixtures/strikes.json";
import symbolEquity from "../fixtures/symbol-details-equity.json";
import symbolOption from "../fixtures/symbol-details-option.json";
import { SIM_BASE, failureOf, json, okToken, run, scriptedFetch } from "./helpers.ts";
import type { FetchFn } from "../../src/tradestation/http.ts";

function transportFor(fetchFn: FetchFn) {
  const made = makeTransport({
    mode: "SIM",
    accessToken: okToken,
    fetch: fetchFn,
    retryDelayMs: 0,
  });
  if (!made.ok) throw new Error(made.reason);
  return made.transport;
}
const withBody = (body: unknown) => {
  const script = scriptedFetch(() => json(body));
  return { transport: transportFor(script.fetch), calls: script.calls };
};

describe("accounts", () => {
  it("decodes the spec example", async () => {
    const { transport, calls } = withBody(accountsFixture);
    expect(await run(market.accounts(transport))).toEqual([
      {
        accountId: "123456789",
        kind: "Cash",
        active: true,
        optionApprovalLevel: 0,
        label: "123456789",
      },
      {
        accountId: "123456782",
        kind: "Margin",
        active: true,
        optionApprovalLevel: 1,
        label: "123456782",
      },
      {
        accountId: "123456781",
        kind: "Futures",
        active: true,
        optionApprovalLevel: 0,
        label: "123456781",
      },
    ]);
    expect(calls[0]?.url).toBe(`${SIM_BASE}/brokerage/accounts`);
  });

  it("marks non-active accounts and skips unknown types", async () => {
    const { transport } = withBody({
      Accounts: [
        { AccountID: "A1", AccountType: "Margin", Status: "Closed" },
        { AccountID: "A2", AccountType: "Crypto", Status: "Active" },
      ],
    });
    expect(await run(market.accounts(transport))).toEqual([
      { accountId: "A1", kind: "Margin", active: false, optionApprovalLevel: 0, label: "A1" },
    ]);
  });

  it("fails as Unknown on an undecodable body", async () => {
    const { transport } = withBody({ Accounts: [{ AccountID: 7 }] });
    expect(await failureOf(market.accounts(transport))).toMatchObject({
      _tag: "Unknown",
      detail: "invalid_response",
    });
  });
});

describe("symbolDetails", () => {
  it("decodes an equity", async () => {
    const { transport, calls } = withBody(symbolEquity);
    expect(await run(market.symbolDetails(transport, "MSFT"))).toEqual({
      symbol: "MSFT",
      assetType: "equity",
      option: null,
      pointValue: 1,
      quantityIncrement: 1,
      minimumTradeQuantity: 1,
    });
    expect(calls[0]?.url).toBe(`${SIM_BASE}/marketdata/symbols/MSFT`);
  });

  it("decodes an option and encodes its symbol in the path", async () => {
    const { transport, calls } = withBody(symbolOption);
    const symbol = "MSFT 211217P332.5";
    expect(await run(market.symbolDetails(transport, symbol))).toMatchObject({
      assetType: "option",
      pointValue: 100,
      option: {
        underlying: "MSFT",
        expiration: "2021-12-17",
        strike: 332_500_000,
        right: "put",
      },
    });
    expect(calls[0]?.url).toBe(`${SIM_BASE}/marketdata/symbols/MSFT%20211217P332.5`);
  });

  it("rejects a symbol the broker does not return and an out-of-scope asset type", async () => {
    expect(
      await failureOf(market.symbolDetails(withBody(symbolEquity).transport, "AAPL")),
    ).toMatchObject({
      _tag: "Rejected",
      code: "UNKNOWN_SYMBOL",
    });
    const future = {
      Symbols: [
        {
          ...symbolEquity.Symbols[0],
          Symbol: "@C",
          AssetType: "FUTURE",
        },
      ],
    };
    expect(await failureOf(market.symbolDetails(withBody(future).transport, "@C"))).toMatchObject({
      _tag: "Rejected",
      code: "OUT_OF_SCOPE",
    });
  });
});

describe("quotes", () => {
  it("decodes the spec example to micro-dollars and stamps our receive time", async () => {
    const { transport, calls } = withBody(quotesFixture);
    const quotes = await run(market.quotes(transport, ["MSFT", "NOPE"], () => 1_800_000_000_000));
    expect(quotes).toEqual([
      {
        symbol: "MSFT",
        bid: 212_850_000,
        ask: 212_870_000,
        last: 212_850_000,
        tradeTime: Date.parse("2020-11-18T15:19:14Z"),
        receivedAt: 1_800_000_000_000,
        isDelayed: false,
        isHalted: false,
      },
    ]);
    expect(calls[0]?.url).toBe(`${SIM_BASE}/marketdata/quotes/MSFT,NOPE`);
  });

  it("keeps a one-sided or empty quote explicit as null, never 0", async () => {
    const { transport } = withBody({
      Quotes: [{ Symbol: "X", Bid: "1", Last: "1", TradeTime: "2020-11-18T15:19:14Z" }],
    });
    expect(await run(market.quotes(transport, ["X"], () => 7))).toEqual([
      {
        symbol: "X",
        bid: 1_000_000,
        ask: null,
        last: 1_000_000,
        tradeTime: Date.parse("2020-11-18T15:19:14Z"),
        receivedAt: 7,
        isDelayed: false,
        isHalted: false,
      },
    ]);
    const empty = withBody({ Quotes: [{ Symbol: "Y" }] });
    expect(await run(market.quotes(empty.transport, ["Y"], () => 7))).toMatchObject([
      { symbol: "Y", bid: null, ask: null, last: null, tradeTime: null },
    ]);
  });

  it("flags delayed and halted quotes", async () => {
    const { transport } = withBody({
      Quotes: [
        {
          Symbol: "X",
          Bid: "1",
          Ask: 1.5,
          Last: "1.25",
          TradeTime: "2020-11-18T15:19:14Z",
          MarketFlags: { IsDelayed: true, IsHalted: true },
        },
      ],
    });
    expect(await run(market.quotes(transport, ["X"], () => 0))).toMatchObject([
      { ask: 1_500_000, isDelayed: true, isHalted: true },
    ]);
  });

  it("refuses more than 100 symbols without sending", async () => {
    const { transport, calls } = withBody(quotesFixture);
    const symbols = Array.from({ length: 101 }, (_, i) => `S${i}`);
    expect(await failureOf(market.quotes(transport, symbols, () => 0))).toMatchObject({
      _tag: "Rejected",
      code: "TOO_MANY_SYMBOLS",
    });
    expect(calls).toHaveLength(0);
  });

  it("fails as Unknown on a price with more than six decimals", async () => {
    const { transport } = withBody({
      Quotes: [
        { Symbol: "X", Bid: "1.1234567", Ask: "2", Last: "1", TradeTime: "2020-11-18T15:19:14Z" },
      ],
    });
    expect(await failureOf(market.quotes(transport, ["X"], () => 0))).toMatchObject({
      _tag: "Unknown",
      detail: "invalid_value:Bid",
    });
  });
});

describe("option expirations and strikes", () => {
  it("returns sorted unique ISO dates", async () => {
    const { transport, calls } = withBody(expirationsFixture);
    expect(await run(market.optionExpirations(transport, "AAPL"))).toEqual([
      "2021-12-17",
      "2021-12-23",
      "2021-12-31",
    ]);
    expect(calls[0]?.url).toBe(`${SIM_BASE}/marketdata/options/expirations/AAPL`);
  });

  it("returns sorted single-contract strikes in micro-dollars", async () => {
    const { transport, calls } = withBody(strikesFixture);
    expect(await run(market.optionStrikes(transport, "MSFT", "2021-12-17"))).toEqual([
      330_000_000, 332_500_000, 335_000_000,
    ]);
    expect(calls[0]?.url).toBe(
      `${SIM_BASE}/marketdata/options/strikes/MSFT?expiration=2021-12-17&spreadType=Single`,
    );
  });

  it("fails as Unknown when a strike row is not a single contract", async () => {
    const { transport } = withBody({ Strikes: [["1", "2"]] });
    expect(await failureOf(market.optionStrikes(transport, "MSFT", "2021-12-17"))).toMatchObject({
      _tag: "Unknown",
    });
  });
});

const optionQuote = (symbol: string, bid: string | null, ask: string | null) => ({
  Symbol: symbol,
  ...(bid === null ? {} : { Bid: bid }),
  ...(ask === null ? {} : { Ask: ask }),
});

describe("chainSnapshot", () => {
  // The SIM chain stream of 2026-10-26 never sent EndSnapshot (docs/tradestation-integration.md),
  // so the chain is the strikes plus one quotes snapshot, with no stream.
  it("quotes both sides of every listed strike and never opens a stream", async () => {
    const script = scriptedFetch(
      () => json({ Strikes: [["11.5"], ["12"]] }),
      () =>
        json({
          Quotes: [
            optionQuote("F 261030C11.5", "0.4", "0.47"),
            optionQuote("F 261030P11.5", "0.1", "0.15"),
            optionQuote("F 261030C12", "0.03", "0.05"),
          ],
          Errors: [{ Symbol: "F 261030P12", Error: "SymbolNotFound" }],
        }),
    );
    const rows = await run(market.chainSnapshot(transportFor(script.fetch), "F", "2026-10-30"));
    expect(rows).toEqual([
      {
        symbol: "F 261030C11.5",
        expiration: "2026-10-30",
        strike: 11_500_000,
        right: "call",
        bid: 400_000,
        ask: 470_000,
      },
      {
        symbol: "F 261030P11.5",
        expiration: "2026-10-30",
        strike: 11_500_000,
        right: "put",
        bid: 100_000,
        ask: 150_000,
      },
      {
        symbol: "F 261030C12",
        expiration: "2026-10-30",
        strike: 12_000_000,
        right: "call",
        bid: 30_000,
        ask: 50_000,
      },
    ]);
    const symbols = ["F 261030C11.5", "F 261030P11.5", "F 261030C12", "F 261030P12"];
    expect(script.calls.map((call) => call.url)).toEqual([
      `${SIM_BASE}/marketdata/options/strikes/F?expiration=2026-10-30&spreadType=Single`,
      `${SIM_BASE}/marketdata/quotes/${symbols.map(encodeURIComponent).join(",")}`,
    ]);
  });

  it("reads only the quotes when the caller already holds the strikes", async () => {
    const script = scriptedFetch(() =>
      json({ Quotes: [optionQuote("F 261030C11.5", "0.4", "0.47")] }),
    );
    const rows = await run(
      market.chainSnapshot(transportFor(script.fetch), "F", "2026-10-30", [11_500_000]),
    );
    expect(rows.map((row) => row.symbol)).toEqual(["F 261030C11.5"]);
    expect(script.calls.map((call) => call.url)).toEqual([
      `${SIM_BASE}/marketdata/quotes/${["F 261030C11.5", "F 261030P11.5"].map(encodeURIComponent).join(",")}`,
    ]);
  });

  it("leaves out a side with a missing or one-sided quote, never as 0", async () => {
    const script = scriptedFetch(
      () => json({ Strikes: [["11.5"]] }),
      () =>
        json({
          Quotes: [
            optionQuote("F 261030C11.5", "0.4", null),
            optionQuote("F 261030P11.5", null, "0.15"),
          ],
        }),
    );
    expect(await run(market.chainSnapshot(transportFor(script.fetch), "F", "2026-10-30"))).toEqual(
      [],
    );
  });

  it("splits the symbols into requests of at most 100", async () => {
    const strikes = Array.from({ length: 60 }, (_, index) => [`${10 + index}`]);
    const script = scriptedFetch(
      () => json({ Strikes: strikes }),
      () => json({ Quotes: [] }),
    );
    await run(market.chainSnapshot(transportFor(script.fetch), "F", "2026-10-30"));
    const sizes = script.calls
      .slice(1)
      .map((call) => decodeURIComponent(call.url).split(",").length);
    expect(sizes).toEqual([100, 20]);
  });

  it("fails like the underlying calls when the strikes or the quotes fail", async () => {
    const strikesDown = scriptedFetch(() => json({ Error: "TooManyRequests" }, 429));
    expect(
      await failureOf(market.chainSnapshot(transportFor(strikesDown.fetch), "F", "2026-10-30")),
    ).toMatchObject({ _tag: "RateLimited" });
    const quotesDown = scriptedFetch(
      () => json({ Strikes: [["11.5"]] }),
      () => json({ Error: "TooManyRequests" }, 429),
    );
    expect(
      await failureOf(market.chainSnapshot(transportFor(quotesDown.fetch), "F", "2026-10-30")),
    ).toMatchObject({ _tag: "RateLimited" });
  });
});

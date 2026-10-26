// Accounts and market data against TradeStation's v3 API (docs/tradestation-integration.md#endpoints-used).
// Field names come from the official OpenAPI spec; behavior it leaves open is marked (verify) and is
// covered by the SIM spike (#21). Every response is decoded with Schema before any field is used.

import { Effect, Schema } from "effect";
import type {
  AssetType,
  BrokerAccount,
  ChainRow,
  OptionContract,
  Quote,
  SymbolDetails,
} from "../broker/adapter.ts";
import { Rejected, Unknown, type BrokerError } from "../broker/errors.ts";
import type { Transport } from "./http.ts";
import {
  WireNumber,
  blankable,
  decodeWire,
  epochOf,
  integerOf,
  isoDateOf,
  microsOf,
  symbolPath,
} from "./values.ts";

/** Per the quotes endpoint: no more than 100 symbols per request. */
const MAX_QUOTE_SYMBOLS = 100;

const AccountsResponse = Schema.Struct({
  Accounts: Schema.Array(
    Schema.Struct({
      AccountID: Schema.String.check(Schema.isMinLength(1)),
      AccountType: Schema.String,
      Status: Schema.String,
      AccountDetail: blankable(Schema.Struct({ OptionApprovalLevel: blankable(WireNumber) })),
    }),
  ),
});

const accountKindOf = (wire: string): BrokerAccount["kind"] | null =>
  wire === "Cash" || wire === "Margin" || wire === "Futures" || wire === "DVP" ? wire : null;

export const accounts = (
  transport: Transport,
): Effect.Effect<ReadonlyArray<BrokerAccount>, BrokerError> =>
  Effect.gen(function* () {
    const body = yield* transport.get("accounts", "/brokerage/accounts");
    const decoded = yield* decodeWire("accounts", AccountsResponse, body);
    const result: BrokerAccount[] = [];
    for (const account of decoded.Accounts) {
      const kind = accountKindOf(account.AccountType);
      if (kind === null) continue;
      const level = account.AccountDetail?.OptionApprovalLevel;
      result.push({
        accountId: account.AccountID,
        kind,
        // (verify) the Status strings; the spec example shows "Active".
        active: account.Status.toLowerCase() === "active",
        optionApprovalLevel:
          level === undefined || level === null
            ? 0
            : yield* integerOf("accounts", "OptionApprovalLevel", level),
        label: account.AccountID,
      });
    }
    return result;
  });

const SymbolDetailsResponse = Schema.Struct({
  Symbols: blankable(
    Schema.Array(
      Schema.Struct({
        Symbol: Schema.String,
        AssetType: Schema.String,
        Underlying: blankable(Schema.String),
        ExpirationDate: blankable(Schema.String),
        StrikePrice: blankable(WireNumber),
        OptionType: blankable(Schema.String),
        PriceFormat: Schema.Struct({ PointValue: WireNumber }),
        QuantityFormat: Schema.Struct({
          Increment: WireNumber,
          MinimumTradeQuantity: WireNumber,
        }),
      }),
    ),
  ),
  Errors: blankable(Schema.Array(Schema.Struct({ Symbol: blankable(Schema.String) }))),
});

const assetTypeOf = (wire: string): AssetType | null =>
  wire === "STOCK" ? "equity" : wire === "STOCKOPTION" ? "option" : null;

/** Underlying, expiry, strike (micro-dollars) and right of an option symbol; all four are required. */
const optionContractOf = (
  underlying: string | null | undefined,
  expirationDate: string | null | undefined,
  strikePrice: WireNumber | null | undefined,
  optionType: string | null | undefined,
): Effect.Effect<OptionContract, Unknown> =>
  Effect.gen(function* () {
    const right = optionType?.toLowerCase();
    if (
      underlying == null ||
      expirationDate == null ||
      strikePrice == null ||
      (right !== "call" && right !== "put")
    ) {
      return yield* Effect.fail(
        new Unknown({ operation: "symbolDetails", detail: "invalid_value:option" }),
      );
    }
    return {
      underlying,
      expiration: yield* isoDateOf("symbolDetails", "ExpirationDate", expirationDate),
      strike: yield* microsOf("symbolDetails", "StrikePrice", strikePrice),
      right,
    };
  });

export const symbolDetails = (
  transport: Transport,
  symbol: string,
): Effect.Effect<SymbolDetails, BrokerError> =>
  Effect.gen(function* () {
    const body = yield* transport.get(
      "symbolDetails",
      `/marketdata/symbols/${symbolPath([symbol])}`,
    );
    const decoded = yield* decodeWire("symbolDetails", SymbolDetailsResponse, body);
    const found = decoded.Symbols?.find((candidate) => candidate.Symbol === symbol);
    if (found === undefined) {
      return yield* Effect.fail(
        new Rejected({ operation: "symbolDetails", code: "UNKNOWN_SYMBOL", reason: symbol }),
      );
    }
    const assetType = assetTypeOf(found.AssetType);
    if (assetType === null) {
      return yield* Effect.fail(
        new Rejected({ operation: "symbolDetails", code: "OUT_OF_SCOPE", reason: found.AssetType }),
      );
    }
    const option =
      assetType === "equity"
        ? null
        : yield* optionContractOf(
            found.Underlying,
            found.ExpirationDate,
            found.StrikePrice,
            found.OptionType,
          );
    return {
      symbol,
      assetType,
      option,
      // The option point value is 100 on SIM (sim/symbols/symbol-option.json); it is read here, never assumed.
      pointValue: yield* integerOf("symbolDetails", "PointValue", found.PriceFormat.PointValue),
      quantityIncrement: yield* integerOf(
        "symbolDetails",
        "Increment",
        found.QuantityFormat.Increment,
      ),
      minimumTradeQuantity: yield* integerOf(
        "symbolDetails",
        "MinimumTradeQuantity",
        found.QuantityFormat.MinimumTradeQuantity,
      ),
    };
  });

const QuotesResponse = Schema.Struct({
  Quotes: blankable(
    Schema.Array(
      Schema.Struct({
        Symbol: Schema.String,
        Bid: blankable(WireNumber),
        Ask: blankable(WireNumber),
        Last: blankable(WireNumber),
        TradeTime: blankable(Schema.String),
        MarketFlags: blankable(
          Schema.Struct({
            IsDelayed: blankable(Schema.Boolean),
            IsHalted: blankable(Schema.Boolean),
          }),
        ),
      }),
    ),
  ),
});

export const quotes = (
  transport: Transport,
  symbols: ReadonlyArray<string>,
  now: () => number,
): Effect.Effect<ReadonlyArray<Quote>, BrokerError> =>
  Effect.gen(function* () {
    if (symbols.length === 0) return [];
    if (symbols.length > MAX_QUOTE_SYMBOLS) {
      return yield* Effect.fail(
        new Rejected({
          operation: "quotes",
          code: "TOO_MANY_SYMBOLS",
          reason: `${symbols.length}`,
        }),
      );
    }
    const body = yield* transport.get("quotes", `/marketdata/quotes/${symbolPath(symbols)}`);
    const receivedAt = now();
    const decoded = yield* decodeWire("quotes", QuotesResponse, body);
    const result: Quote[] = [];
    for (const quote of decoded.Quotes ?? []) {
      // A side the broker did not send stays null; it is never turned into 0 (see Quote).
      const { Bid, Ask, Last, TradeTime } = quote;
      result.push({
        symbol: quote.Symbol,
        bid: Bid == null ? null : yield* microsOf("quotes", "Bid", Bid),
        ask: Ask == null ? null : yield* microsOf("quotes", "Ask", Ask),
        last: Last == null ? null : yield* microsOf("quotes", "Last", Last),
        tradeTime: TradeTime == null ? null : yield* epochOf("quotes", "TradeTime", TradeTime),
        receivedAt,
        isDelayed: quote.MarketFlags?.IsDelayed ?? false,
        isHalted: quote.MarketFlags?.IsHalted ?? false,
      });
    }
    return result;
  });

const ExpirationsResponse = Schema.Struct({
  Expirations: Schema.Array(Schema.Struct({ Date: Schema.String })),
});

export const optionExpirations = (
  transport: Transport,
  underlying: string,
): Effect.Effect<ReadonlyArray<string>, BrokerError> =>
  Effect.gen(function* () {
    const body = yield* transport.get(
      "optionExpirations",
      `/marketdata/options/expirations/${symbolPath([underlying])}`,
    );
    const decoded = yield* decodeWire("optionExpirations", ExpirationsResponse, body);
    const dates = yield* Effect.forEach(decoded.Expirations, (row) =>
      isoDateOf("optionExpirations", "Date", row.Date),
    );
    // Weekly and monthly roots can share a date.
    return [...new Set(dates)].sort();
  });

const StrikesResponse = Schema.Struct({
  Strikes: Schema.Array(Schema.Array(WireNumber)),
});

export const optionStrikes = (
  transport: Transport,
  underlying: string,
  expiration: string,
): Effect.Effect<ReadonlyArray<number>, BrokerError> =>
  Effect.gen(function* () {
    // "Single" is the spread type of one contract; SIM accepts it (sim/expirations/strikes-single.json).
    const body = yield* transport.get(
      "optionStrikes",
      `/marketdata/options/strikes/${symbolPath([underlying])}`,
      { expiration, spreadType: "Single" },
    );
    const decoded = yield* decodeWire("optionStrikes", StrikesResponse, body);
    const strikes = yield* Effect.forEach(decoded.Strikes, (spread) =>
      spread.length === 1 && spread[0] !== undefined
        ? microsOf("optionStrikes", "Strikes", spread[0])
        : Effect.fail(new Unknown({ operation: "optionStrikes", detail: "invalid_value:Strikes" })),
    );
    return [...new Set(strikes)].sort((a, b) => a - b);
  });

const MICROS_PER_UNIT = 1_000_000;

/** `11500000` -> `11.5`: the strike as it appears in an option symbol (no trailing zeros). */
const strikeText = (micros: number): string => {
  const whole = Math.trunc(micros / MICROS_PER_UNIT);
  const fraction = String(micros % MICROS_PER_UNIT)
    .padStart(6, "0")
    .replace(/0+$/, "");
  return fraction === "" ? `${whole}` : `${whole}.${fraction}`;
};

/**
 * The chain of one expiration: the listed strikes, then one quotes snapshot of both contracts of
 * each. The chain stream was not used because, in the SIM run of 2026-10-26, it kept sending
 * updates and never sent `EndSnapshot` (docs/tradestation-integration.md). Quotes are served for
 * option symbols (≤100 per request, so a long chain takes a few requests). A symbol the broker
 * does not know, or a contract without both bid and ask, is simply not in the result.
 * (verify) The symbol is `<underlying> <yymmdd><C|P><strike>`, the shape every sampled symbol had;
 * an underlying whose options trade under another root (index weeklies) is out of scope.
 */
export const chainSnapshot = (
  transport: Transport,
  underlying: string,
  expiration: string,
  knownStrikes?: ReadonlyArray<number>,
): Effect.Effect<ReadonlyArray<ChainRow>, BrokerError> =>
  Effect.gen(function* () {
    // A caller that refreshes prices already holds the strikes (they don't change during a
    // session): only the quotes are read again (D46).
    const strikes = knownStrikes ?? (yield* optionStrikes(transport, underlying, expiration));
    const datePart = expiration.slice(2).replaceAll("-", "");
    const contracts = strikes.flatMap((strike) =>
      (["call", "put"] as const).map((right) => ({
        symbol: `${underlying} ${datePart}${right === "call" ? "C" : "P"}${strikeText(strike)}`,
        strike,
        right,
      })),
    );
    const bySymbol = new Map(contracts.map((contract) => [contract.symbol, contract]));
    const symbols = contracts.map((contract) => contract.symbol);
    const rows: ChainRow[] = [];
    for (let start = 0; start < symbols.length; start += MAX_QUOTE_SYMBOLS) {
      // The receive time is unused here: the caller stamps the chain once it is complete.
      const quoted = yield* quotes(
        transport,
        symbols.slice(start, start + MAX_QUOTE_SYMBOLS),
        () => 0,
      );
      for (const quote of quoted) {
        const contract = bySymbol.get(quote.symbol);
        // A one-sided market is not offered; the side stays null upstream, never 0.
        if (contract === undefined || quote.bid === null || quote.ask === null) continue;
        rows.push({ ...contract, expiration, bid: quote.bid, ask: quote.ask });
      }
    }
    return rows;
  });

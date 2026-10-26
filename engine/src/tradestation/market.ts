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
import { Rejected, Timeout, Unknown, type BrokerError } from "../broker/errors.ts";
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
const DEFAULT_CHAIN_TIMEOUT_MS = 15_000;

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

const ChainMessage = Schema.Struct({
  StreamStatus: blankable(Schema.String),
  Error: blankable(Schema.String),
  Bid: blankable(WireNumber),
  Ask: blankable(WireNumber),
  Legs: blankable(
    Schema.Array(
      Schema.Struct({
        Symbol: Schema.String,
        StrikePrice: WireNumber,
        Expiration: Schema.String,
        OptionType: Schema.String,
      }),
    ),
  ),
});

const toChainRow = (message: typeof ChainMessage.Type): Effect.Effect<ChainRow | null, Unknown> =>
  Effect.gen(function* () {
    const { Legs, Bid, Ask } = message;
    if (Legs == null) return null; // heartbeats and other non-row messages
    const leg = Legs[0];
    if (Legs.length !== 1 || leg === undefined) {
      return yield* Effect.fail(
        new Unknown({ operation: "chainSnapshot", detail: "invalid_value:Legs" }),
      );
    }
    const right = leg.OptionType.toLowerCase();
    if (right !== "call" && right !== "put") {
      return yield* Effect.fail(
        new Unknown({ operation: "chainSnapshot", detail: "invalid_value:OptionType" }),
      );
    }
    // A contract with no two-sided market is not offered.
    if (Bid == null || Ask == null) return null;
    return {
      symbol: leg.Symbol,
      expiration: yield* isoDateOf("chainSnapshot", "Expiration", leg.Expiration),
      strike: yield* microsOf("chainSnapshot", "StrikePrice", leg.StrikePrice),
      right,
      bid: yield* microsOf("chainSnapshot", "Bid", Bid),
      ask: yield* microsOf("chainSnapshot", "Ask", Ask),
    };
  });

/**
 * Reads the chain stream until `{"StreamStatus":"EndSnapshot"}`, then closes it. Messages are
 * newline-delimited JSON and chunk boundaries are not message boundaries (docs: HTTP streaming),
 * so bytes are buffered and split on "\n". The whole read, connection included, is bounded by
 * `timeoutMs`. Streams are limited to 10 concurrent per key, so the stream is always closed.
 */
export const chainSnapshot = (
  transport: Transport,
  underlying: string,
  expiration: string,
  timeoutMs: number = DEFAULT_CHAIN_TIMEOUT_MS,
): Effect.Effect<ReadonlyArray<ChainRow>, BrokerError> =>
  Effect.gen(function* () {
    const stream = yield* transport.openStream(
      "chainSnapshot",
      `/marketdata/stream/options/chains/${symbolPath([underlying])}`,
      // `expiration` takes a plain date on SIM; without strikeProximity the chain had 733 rows (sim/chain/chain-stream.json).
      { expiration, spreadType: "Single", optionType: "All", enableGreeks: "false" },
      timeoutMs,
    );
    const rows = new Map<string, ChainRow>();
    const handleLine = (line: string): Effect.Effect<boolean, Unknown> =>
      Effect.gen(function* () {
        if (line.trim() === "") return false;
        const parsed = yield* Effect.try({
          try: (): unknown => JSON.parse(line),
          catch: () => new Unknown({ operation: "chainSnapshot", detail: "invalid_response" }),
        });
        const message = yield* decodeWire("chainSnapshot", ChainMessage, parsed);
        if (message.Error != null) {
          return yield* Effect.fail(
            new Unknown({ operation: "chainSnapshot", detail: `stream_error:${message.Error}` }),
          );
        }
        if (message.StreamStatus === "EndSnapshot") return true;
        if (message.StreamStatus === "GoAway") {
          return yield* Effect.fail(
            new Unknown({ operation: "chainSnapshot", detail: "stream_go_away" }),
          );
        }
        const row = yield* toChainRow(message);
        if (row !== null) rows.set(row.symbol, row);
        return false;
      });
    return yield* Effect.ensuring(
      readUntilEnd(stream.response, stream.signal, handleLine).pipe(
        Effect.map(() => [...rows.values()]),
      ),
      Effect.sync(stream.abort),
    );
  });

/** Feeds each complete line to `onLine` until it returns true; fails when the stream ends first. */
const readUntilEnd = (
  response: Response,
  signal: AbortSignal,
  onLine: (line: string) => Effect.Effect<boolean, Unknown>,
): Effect.Effect<void, BrokerError> =>
  Effect.gen(function* () {
    const reader = response.body?.getReader();
    if (reader === undefined) {
      return yield* Effect.fail(new Unknown({ operation: "chainSnapshot", detail: "network" }));
    }
    const decoder = new TextDecoder();
    let buffer = "";
    const loop = Effect.gen(function* () {
      while (true) {
        const chunk = yield* Effect.tryPromise({
          // The race makes the timeout hold even for a body that is not tied to the abort signal.
          try: () =>
            Promise.race([
              reader.read(),
              new Promise<never>((_resolve, reject) => {
                if (signal.aborted) reject(signal.reason);
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              }),
            ]),
          catch: (error): BrokerError =>
            typeof error === "object" &&
            error !== null &&
            "name" in error &&
            (error.name === "TimeoutError" || error.name === "AbortError")
              ? new Timeout({ operation: "chainSnapshot" })
              : new Unknown({ operation: "chainSnapshot", detail: "network" }),
        });
        if (chunk.done) {
          if (buffer !== "" && (yield* onLine(buffer))) return;
          return yield* Effect.fail(
            new Unknown({ operation: "chainSnapshot", detail: "stream_ended_early" }),
          );
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (yield* onLine(line)) return;
          newline = buffer.indexOf("\n");
        }
      }
    });
    return yield* Effect.ensuring(
      loop,
      Effect.promise(() => reader.cancel().catch(() => undefined)),
    );
  });

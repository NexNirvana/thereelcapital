// The TradeStation implementation of BrokerAdapter (#19). A REAL adapter is refused at construction
// unless the REAL_TRADING switch is open, as is any base URL but its mode's host; both happen before
// a token is requested (D52).

import { Data, Effect, Layer } from "effect";
import { BrokerAdapter, type BrokerAdapterShape, type BrokerSkip } from "../broker/adapter.ts";
import {
  makeTransport,
  type RateLimitInfo,
  type TransportConfig,
  type TransportRefusal,
} from "./http.ts";
import * as market from "./market.ts";
import * as orders from "./orders.ts";
import * as quoteStream from "./quote-stream.ts";
import * as trading from "./trading.ts";

export interface TradeStationAdapterConfig extends TransportConfig {
  /** Epoch ms; stamps quotes with our receive time. */
  readonly now: () => number;
}

export interface TradeStationAdapter extends BrokerAdapterShape {
  readonly source: "tradestation-sim" | "tradestation-real";
  /** The latest `X-RateLimit-*` headers, for the event log and the sync loop's pacing. */
  readonly rateLimit: () => RateLimitInfo | null;
}

export function makeTradeStationAdapter(
  config: TradeStationAdapterConfig,
):
  | { readonly ok: true; readonly adapter: TradeStationAdapter }
  | { readonly ok: false; readonly reason: TransportRefusal } {
  const made = makeTransport(config);
  if (!made.ok) return made;
  const { transport } = made;
  const guard = trading.makeAccountGuard(transport);
  let skipped: BrokerSkip[] = [];
  return {
    ok: true,
    adapter: {
      source: config.mode === "REAL" ? "tradestation-real" : "tradestation-sim",
      rateLimit: transport.rateLimit,
      accounts: () => market.accounts(transport),
      symbolDetails: (symbol) => market.symbolDetails(transport, symbol),
      quotes: (symbols) => market.quotes(transport, symbols, config.now),
      quoteStream: (symbols, onEvent, signal) =>
        quoteStream.quoteStream(transport, symbols, config.now, onEvent, signal),
      optionExpirations: (underlying) => market.optionExpirations(transport, underlying),
      optionStrikes: (underlying, expiration) =>
        market.optionStrikes(transport, underlying, expiration),
      chainSnapshot: (underlying, expiration, strikes) =>
        market.chainSnapshot(transport, underlying, expiration, strikes),
      confirmOrder: (request) => trading.confirmOrder(transport, guard, request),
      placeOrder: (request) => trading.placeOrder(transport, guard, request),
      cancelOrder: (accountId, orderId) =>
        trading.cancelOrder(transport, guard, accountId, orderId),
      warmAccountGuard: (accountIds) =>
        Effect.forEach(accountIds, (id) => guard.require("accounts", id), { discard: true }),
      orders: (accountIds) => orders.orders(transport, accountIds, skipped),
      historicalOrders: (accountIds, since) =>
        orders.historicalOrders(transport, accountIds, since, skipped),
      positions: (accountIds) => orders.positions(transport, accountIds, skipped),
      takeSkipped: () => {
        const taken = skipped;
        skipped = [];
        return taken;
      },
    },
  };
}

/** Why the layer could not be built. Nothing was sent. */
export class TransportRefused extends Data.TaggedError("TransportRefused")<{
  readonly reason: TransportRefusal;
}> {}

/** The BrokerAdapter service backed by TradeStation; fails to build when the mode's locks are not satisfied. */
export function tradeStationLayer(
  config: TradeStationAdapterConfig,
): Layer.Layer<BrokerAdapter, TransportRefused> {
  return Layer.effect(
    BrokerAdapter,
    Effect.suspend(() => {
      const made = makeTradeStationAdapter(config);
      return made.ok
        ? Effect.succeed(made.adapter)
        : Effect.fail(new TransportRefused({ reason: made.reason }));
    }),
  );
}

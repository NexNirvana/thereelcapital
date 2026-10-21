// The TradeStation SIM implementation of BrokerAdapter (#19). Only SIM exists here: a LIVE mode or
// any base URL but the SIM host is refused at construction, before a token is requested.

import { Data, Effect, Layer } from "effect";
import { BrokerAdapter, type BrokerAdapterShape } from "../broker/adapter.ts";
import {
  makeTransport,
  type RateLimitInfo,
  type TransportConfig,
  type TransportRefusal,
} from "./http.ts";
import * as market from "./market.ts";
import * as orders from "./orders.ts";
import * as trading from "./trading.ts";

export interface TradeStationAdapterConfig extends TransportConfig {
  /** Epoch ms; stamps quotes with our receive time. */
  readonly now: () => number;
  readonly chainTimeoutMs?: number;
}

export interface TradeStationAdapter extends BrokerAdapterShape {
  readonly source: "tradestation-sim";
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
  const guard = trading.makeSimAccountGuard(transport);
  return {
    ok: true,
    adapter: {
      source: "tradestation-sim",
      rateLimit: transport.rateLimit,
      accounts: () => market.accounts(transport),
      symbolDetails: (symbol) => market.symbolDetails(transport, symbol),
      quotes: (symbols) => market.quotes(transport, symbols, config.now),
      optionExpirations: (underlying) => market.optionExpirations(transport, underlying),
      optionStrikes: (underlying, expiration) =>
        market.optionStrikes(transport, underlying, expiration),
      chainSnapshot: (underlying, expiration) =>
        market.chainSnapshot(transport, underlying, expiration, config.chainTimeoutMs),
      confirmOrder: (request) => trading.confirmOrder(transport, guard, request),
      placeOrder: (request) => trading.placeOrder(transport, guard, request),
      cancelOrder: (accountId, orderId) =>
        trading.cancelOrder(transport, guard, accountId, orderId),
      orders: (accountIds) => orders.orders(transport, accountIds),
      historicalOrders: (accountIds, since) =>
        orders.historicalOrders(transport, accountIds, since),
      positions: (accountIds) => orders.positions(transport, accountIds),
    },
  };
}

/** Why the layer could not be built. Nothing was sent. */
export class SimOnlyRefused extends Data.TaggedError("SimOnlyRefused")<{
  readonly reason: TransportRefusal;
}> {}

/** The BrokerAdapter service backed by TradeStation SIM; fails to build when SIM cannot be proven. */
export function tradeStationLayer(
  config: TradeStationAdapterConfig,
): Layer.Layer<BrokerAdapter, SimOnlyRefused> {
  return Layer.effect(
    BrokerAdapter,
    Effect.suspend(() => {
      const made = makeTradeStationAdapter(config);
      return made.ok
        ? Effect.succeed(made.adapter)
        : Effect.fail(new SimOnlyRefused({ reason: made.reason }));
    }),
  );
}

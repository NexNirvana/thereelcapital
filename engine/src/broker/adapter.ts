// The broker boundary of the engine: domain-shaped requests and responses, implemented by the
// TradeStation SIM adapter (#19) and by the local simulation (local-sim/). Prices are integer
// micro-dollars, quantities are integers, times are epoch milliseconds
// (docs/architecture.md#effect-usage).

import { Context, type Effect } from "effect";
import type { BrokerError } from "./errors.ts";

/** Who answers: shown next to anything that comes from the simulation. */
export type BrokerSource = "tradestation-sim" | "local-sim";

export const LOCAL_SIM_LABEL = "simulación local";

export type AssetType = "equity" | "option";

export interface BrokerAccount {
  readonly accountId: string;
  readonly kind: "Cash" | "Margin" | "Futures" | "DVP";
  readonly active: boolean;
  readonly optionApprovalLevel: number;
  /** Display name; the local simulation always uses LOCAL_SIM_LABEL. */
  readonly label: string;
}

export interface SymbolDetails {
  readonly symbol: string;
  readonly assetType: AssetType;
  /** Price multiplier (100 for standard options, to be verified against SIM). */
  readonly pointValue: number;
  readonly quantityIncrement: number;
  readonly minimumTradeQuantity: number;
}

export interface Quote {
  readonly symbol: string;
  readonly bid: number;
  readonly ask: number;
  readonly last: number;
  readonly tradeTime: number;
  /** Our own receive time: the broker has no bid/ask timestamp, so freshness is judged from this. */
  readonly receivedAt: number;
  readonly isDelayed: boolean;
  readonly isHalted: boolean;
}

export interface ChainRow {
  readonly symbol: string;
  readonly expiration: string;
  readonly strike: number;
  readonly right: "call" | "put";
  readonly bid: number;
  readonly ask: number;
}

/** Entries open a position, exits close it; SELLTOOPEN and BUYTOCLOSE are not representable. */
export type TradeAction = "BUY" | "SELL" | "BUYTOOPEN" | "SELLTOCLOSE";

/** MARKET, DAY, regular session is the only order the product sends, so the request has no fields for it. */
export interface OrderRequest {
  readonly accountId: string;
  readonly symbol: string;
  readonly assetType: AssetType;
  readonly tradeAction: TradeAction;
  readonly quantity: number;
  /** The intent id; the broker rejects or returns the same order for a repeated id. */
  readonly orderConfirmId: string;
}

export interface OrderPreview {
  readonly orderConfirmId: string;
  readonly estimatedPriceMicros: number;
}

export interface PlacedOrder {
  readonly orderId: string;
}

/** Intent states a broker status maps to (docs/tradestation-integration.md#endpoints-used). */
export type BrokerOrderStatus = "ACKNOWLEDGED" | "PARTIAL" | "FILLED" | "CANCELED" | "REJECTED";

export interface BrokerOrder {
  readonly orderId: string;
  /** Null for orders made outside REEL CAPITAL. */
  readonly orderConfirmId: string | null;
  readonly accountId: string;
  readonly symbol: string;
  readonly tradeAction: TradeAction;
  readonly quantity: number;
  readonly filledQty: number;
  readonly remainingQty: number;
  readonly avgFillPriceMicros: number | null;
  /** UNMAPPED: keep the current intent state and log it. */
  readonly status: BrokerOrderStatus | "UNMAPPED";
  readonly rawStatus: string;
  readonly openedAt: number;
  readonly closedAt: number | null;
}

export interface BrokerPosition {
  readonly accountId: string;
  readonly symbol: string;
  readonly assetType: AssetType;
  readonly quantity: number;
  readonly avgPriceMicros: number;
}

type Op<A> = Effect.Effect<A, BrokerError>;

export interface BrokerAdapterShape {
  readonly source: BrokerSource;
  readonly accounts: () => Op<ReadonlyArray<BrokerAccount>>;
  readonly symbolDetails: (symbol: string) => Op<SymbolDetails>;
  /** Symbols the broker has no quote for are absent from the result. */
  readonly quotes: (symbols: ReadonlyArray<string>) => Op<ReadonlyArray<Quote>>;
  /** ISO dates, ascending. */
  readonly optionExpirations: (underlying: string) => Op<ReadonlyArray<string>>;
  readonly optionStrikes: (underlying: string, expiration: string) => Op<ReadonlyArray<number>>;
  /** One snapshot of the chain with bid/ask; the stream is read until EndSnapshot, then closed. */
  readonly chainSnapshot: (underlying: string, expiration: string) => Op<ReadonlyArray<ChainRow>>;
  readonly confirmOrder: (request: OrderRequest) => Op<OrderPreview>;
  /** Never retried: Timeout and Unknown mean the order may exist. */
  readonly placeOrder: (request: OrderRequest) => Op<PlacedOrder>;
  /** Never retried. Success means "cancel request sent", not CANCELED. */
  readonly cancelOrder: (accountId: string, orderId: string) => Op<PlacedOrder>;
  readonly orders: (accountIds: ReadonlyArray<string>) => Op<ReadonlyArray<BrokerOrder>>;
  /** Closed orders only, from `since` (epoch ms). */
  readonly historicalOrders: (
    accountIds: ReadonlyArray<string>,
    since: number,
  ) => Op<ReadonlyArray<BrokerOrder>>;
  readonly positions: (accountIds: ReadonlyArray<string>) => Op<ReadonlyArray<BrokerPosition>>;
}

export class BrokerAdapter extends Context.Service<BrokerAdapter, BrokerAdapterShape>()(
  "reel/BrokerAdapter",
) {}

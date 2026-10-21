// In-memory broker for development and engine tests (#20). It reproduces the broker behavior the
// engine must survive; it is never evidence about TradeStation itself (docs/test-plan.md).
// No network, no Date.now, no Math.random: time comes from `now` and ids from `seed`, so a
// scripted scenario always plays out the same way. Prices are micro-dollars, quantities integers.

import { Effect, Layer } from "effect";
import {
  BrokerAdapter,
  LOCAL_SIM_LABEL,
  type AssetType,
  type BrokerAccount,
  type BrokerAdapterShape,
  type BrokerOrder,
  type BrokerOrderStatus,
  type BrokerPosition,
  type ChainRow,
  type OrderRequest,
  type Quote,
  type SymbolDetails,
} from "../adapter.ts";
import { Rejected, type BrokerError, type BrokerOperation } from "../errors.ts";

/** How a MARKET order fills after it is accepted. */
export type FillMode =
  | { readonly kind: "instant" }
  /** `qty` fills at once; the rest fills `completeAfterMs` later, or stays open when omitted. */
  | { readonly kind: "partial"; readonly qty: number; readonly completeAfterMs?: number }
  /** Acknowledged now, filled in full `afterMs` later. */
  | { readonly kind: "delayed"; readonly afterMs: number };

export interface SimSymbol {
  readonly symbol: string;
  readonly assetType: AssetType;
  readonly bid: number;
  readonly ask: number;
  readonly last?: number;
  readonly pointValue?: number;
  readonly quantityIncrement?: number;
  readonly minimumTradeQuantity?: number;
  /** Contract data of an option; underlying, expirations, strikes and chains derive from it. */
  readonly option?: {
    readonly underlying: string;
    readonly expiration: string;
    readonly strike: number;
    readonly right: "call" | "put";
  };
}

export interface SimAccount {
  readonly accountId: string;
  readonly kind?: BrokerAccount["kind"];
  readonly active?: boolean;
  readonly optionApprovalLevel?: number;
}

export interface LocalSimConfig {
  /** Epoch milliseconds; the only clock the simulation reads. */
  readonly now: () => number;
  /** Namespaces generated order ids so two simulations never share ids. */
  readonly seed: string;
  readonly accounts: ReadonlyArray<SimAccount>;
  readonly symbols: ReadonlyArray<SimSymbol>;
  readonly fill?: FillMode;
}

interface QuoteState {
  bid: number;
  ask: number;
  last: number;
  tradeTime: number;
  isDelayed: boolean;
  isHalted: boolean;
}

interface ScheduledFill {
  readonly at: number;
  readonly qty: number;
}

interface SimOrder {
  readonly orderId: string;
  readonly request: OrderRequest;
  readonly priceMicros: number;
  readonly openedAt: number;
  filledQty: number;
  closedAt: number | null;
  ended: "CANCELED" | "REJECTED" | null;
  schedule: ScheduledFill[];
}

interface SimPosition {
  readonly accountId: string;
  readonly symbol: string;
  readonly assetType: AssetType;
  quantity: number;
  avgPriceMicros: number;
}

export interface LocalSim {
  readonly adapter: BrokerAdapterShape;
  /** Quote and fill-mode controls for scripting scenarios. */
  readonly setFill: (fill: FillMode) => void;
  readonly setQuote: (symbol: string, update: Partial<QuoteState>) => void;
}

const isEntry = (action: OrderRequest["tradeAction"]) => action === "BUY" || action === "BUYTOOPEN";

/** Integer weighted average, half-up. */
function weightedAvg(qtyA: number, avgA: number, qtyB: number, avgB: number): number {
  const total = qtyA + qtyB;
  return Math.floor((2 * (qtyA * avgA + qtyB * avgB) + total) / (2 * total));
}

const RAW_STATUS: Record<BrokerOrderStatus, string> = {
  ACKNOWLEDGED: "ACK",
  PARTIAL: "FPR",
  FILLED: "FLL",
  CANCELED: "CAN",
  REJECTED: "REJ",
};

export function makeLocalSim(config: LocalSimConfig): LocalSim {
  const { now } = config;
  let fill: FillMode = config.fill ?? { kind: "instant" };
  let sequence = 0;

  const accounts = new Map(config.accounts.map((a) => [a.accountId, a]));
  const symbols = new Map(config.symbols.map((s) => [s.symbol, s]));
  const quotes = new Map<string, QuoteState>(
    config.symbols.map((s) => [
      s.symbol,
      {
        bid: s.bid,
        ask: s.ask,
        last: s.last ?? s.ask,
        tradeTime: now(),
        isDelayed: false,
        isHalted: false,
      },
    ]),
  );
  const orders = new Map<string, SimOrder>();
  const orderIdByConfirmId = new Map<string, string>();
  const positions = new Map<string, SimPosition>();
  const positionKey = (accountId: string, symbol: string) => `${accountId}\u0000${symbol}`;

  const reject = (operation: BrokerOperation, code: string, reason: string) =>
    Effect.fail(new Rejected({ operation, code, reason }));

  /** Every operation applies the fills that came due before it looks at state. */
  const call = <A>(
    operation: BrokerOperation,
    body: (operation: BrokerOperation) => Effect.Effect<A, BrokerError>,
  ): Effect.Effect<A, BrokerError> =>
    Effect.suspend(() => {
      settle();
      return body(operation);
    });

  function applyFill(order: SimOrder, qty: number, at: number): void {
    const { accountId, symbol, assetType, tradeAction } = order.request;
    const key = positionKey(accountId, symbol);
    const held = positions.get(key);
    if (isEntry(tradeAction)) {
      positions.set(key, {
        accountId,
        symbol,
        assetType,
        quantity: (held?.quantity ?? 0) + qty,
        avgPriceMicros: weightedAvg(
          held?.quantity ?? 0,
          held?.avgPriceMicros ?? 0,
          qty,
          order.priceMicros,
        ),
      });
    } else if (held !== undefined) {
      if (held.quantity === qty) positions.delete(key);
      else held.quantity -= qty;
    }
    order.filledQty += qty;
    if (order.filledQty === order.request.quantity) order.closedAt = at;
  }

  function settle(): void {
    const at = now();
    for (const order of orders.values()) {
      if (order.ended !== null) continue;
      const due = order.schedule.filter((f) => f.at <= at).sort((a, b) => a.at - b.at);
      order.schedule = order.schedule.filter((f) => f.at > at);
      for (const f of due) applyFill(order, f.qty, f.at);
    }
  }

  function statusOf(order: SimOrder): BrokerOrderStatus {
    if (order.ended !== null) return order.ended;
    if (order.filledQty === order.request.quantity) return "FILLED";
    return order.filledQty > 0 ? "PARTIAL" : "ACKNOWLEDGED";
  }

  function toBrokerOrder(order: SimOrder): BrokerOrder {
    const status = statusOf(order);
    const open = order.ended === null && status !== "FILLED";
    return {
      orderId: order.orderId,
      orderConfirmId: order.request.orderConfirmId,
      accountId: order.request.accountId,
      symbol: order.request.symbol,
      tradeAction: order.request.tradeAction,
      quantity: order.request.quantity,
      filledQty: order.filledQty,
      remainingQty: open ? order.request.quantity - order.filledQty : 0,
      avgFillPriceMicros: order.filledQty > 0 ? order.priceMicros : null,
      status,
      rawStatus: RAW_STATUS[status],
      openedAt: order.openedAt,
      closedAt: open ? null : (order.closedAt ?? order.openedAt),
    };
  }

  function knownAccounts(
    operation: BrokerOperation,
    accountIds: ReadonlyArray<string>,
  ): Effect.Effect<void, BrokerError> {
    const unknown = accountIds.find((id) => !accounts.has(id));
    return unknown === undefined
      ? Effect.void
      : reject(operation, "UNKNOWN_ACCOUNT", `Unknown account ${unknown}`);
  }

  /** The checks the broker applies to an order; returns the market price it would fill at. */
  function validate(
    operation: BrokerOperation,
    request: OrderRequest,
  ): Effect.Effect<number, BrokerError> {
    const account = accounts.get(request.accountId);
    const instrument = symbols.get(request.symbol);
    const quote = quotes.get(request.symbol);
    if (account === undefined || account.active === false) {
      return reject(operation, "UNKNOWN_ACCOUNT", `Unusable account ${request.accountId}`);
    }
    if (instrument === undefined || quote === undefined) {
      return reject(operation, "UNKNOWN_SYMBOL", `Unknown symbol ${request.symbol}`);
    }
    if (request.orderConfirmId === "") {
      return reject(operation, "INVALID_ORDER", "OrderConfirmID is required");
    }
    const actionFits =
      instrument.assetType === "equity"
        ? request.tradeAction === "BUY" || request.tradeAction === "SELL"
        : request.tradeAction === "BUYTOOPEN" || request.tradeAction === "SELLTOCLOSE";
    if (!actionFits || request.assetType !== instrument.assetType) {
      return reject(operation, "INVALID_ORDER", "Trade action does not fit the instrument");
    }
    const increment = instrument.quantityIncrement ?? 1;
    if (
      !Number.isSafeInteger(request.quantity) ||
      request.quantity < (instrument.minimumTradeQuantity ?? 1) ||
      request.quantity % increment !== 0
    ) {
      return reject(operation, "INVALID_QUANTITY", `Quantity ${request.quantity} is not tradable`);
    }
    if (quote.isHalted) return reject(operation, "HALTED", `${request.symbol} is halted`);
    if (!isEntry(request.tradeAction)) {
      const held = positions.get(positionKey(request.accountId, request.symbol))?.quantity ?? 0;
      let working = 0;
      for (const o of orders.values()) {
        if (
          o.ended === null &&
          o.request.accountId === request.accountId &&
          o.request.symbol === request.symbol &&
          !isEntry(o.request.tradeAction)
        ) {
          working += o.request.quantity - o.filledQty;
        }
      }
      if (request.quantity > held - working) {
        return reject(operation, "INSUFFICIENT_POSITION", "Not enough shares to sell");
      }
    }
    return Effect.succeed(isEntry(request.tradeAction) ? quote.ask : quote.bid);
  }

  function scheduleFor(quantity: number, at: number): ScheduledFill[] {
    switch (fill.kind) {
      case "instant":
        return [{ at, qty: quantity }];
      case "delayed":
        return [{ at: at + fill.afterMs, qty: quantity }];
      case "partial": {
        const first = Math.min(fill.qty, quantity);
        const rest = quantity - first;
        return [
          { at, qty: first },
          ...(rest > 0 && fill.completeAfterMs !== undefined
            ? [{ at: at + fill.completeAfterMs, qty: rest }]
            : []),
        ].filter((f) => f.qty > 0);
      }
    }
  }

  function optionsOf(
    underlying: string,
  ): ReadonlyArray<SimSymbol & { option: NonNullable<SimSymbol["option"]> }> {
    const found: Array<SimSymbol & { option: NonNullable<SimSymbol["option"]> }> = [];
    for (const s of config.symbols) {
      if (s.option?.underlying === underlying) found.push({ ...s, option: s.option });
    }
    return found;
  }

  const unique = <T>(values: ReadonlyArray<T>) => [...new Set(values)];

  const adapter: BrokerAdapterShape = {
    source: "local-sim",

    accounts: () =>
      call("accounts", () =>
        Effect.succeed(
          config.accounts.map((a): BrokerAccount => ({
            accountId: a.accountId,
            kind: a.kind ?? "Margin",
            active: a.active ?? true,
            optionApprovalLevel: a.optionApprovalLevel ?? 2,
            label: LOCAL_SIM_LABEL,
          })),
        ),
      ),

    symbolDetails: (symbol) =>
      call("symbolDetails", (operation) => {
        const s = symbols.get(symbol);
        if (s === undefined) return reject(operation, "UNKNOWN_SYMBOL", `Unknown symbol ${symbol}`);
        const details: SymbolDetails = {
          symbol,
          assetType: s.assetType,
          pointValue: s.pointValue ?? (s.assetType === "option" ? 100 : 1),
          quantityIncrement: s.quantityIncrement ?? 1,
          minimumTradeQuantity: s.minimumTradeQuantity ?? 1,
        };
        return Effect.succeed(details);
      }),

    quotes: (requested) =>
      call("quotes", () => {
        const received = now();
        const found: Quote[] = [];
        for (const symbol of requested) {
          const q = quotes.get(symbol);
          if (q !== undefined) found.push({ symbol, ...q, receivedAt: received });
        }
        return Effect.succeed(found);
      }),

    optionExpirations: (underlying) =>
      call("optionExpirations", (operation) => {
        const contracts = optionsOf(underlying);
        if (contracts.length === 0) {
          return reject(operation, "UNKNOWN_SYMBOL", `No options for ${underlying}`);
        }
        return Effect.succeed(unique(contracts.map((c) => c.option.expiration)).sort());
      }),

    optionStrikes: (underlying, expiration) =>
      call("optionStrikes", (operation) => {
        const contracts = optionsOf(underlying).filter((c) => c.option.expiration === expiration);
        if (contracts.length === 0) {
          return reject(operation, "UNKNOWN_SYMBOL", `No ${expiration} options for ${underlying}`);
        }
        return Effect.succeed(unique(contracts.map((c) => c.option.strike)).sort((a, b) => a - b));
      }),

    chainSnapshot: (underlying, expiration) =>
      call("chainSnapshot", (operation) => {
        const rows: ChainRow[] = [];
        for (const c of optionsOf(underlying)) {
          const q = quotes.get(c.symbol);
          if (c.option.expiration === expiration && q !== undefined) {
            rows.push({
              symbol: c.symbol,
              expiration,
              strike: c.option.strike,
              right: c.option.right,
              bid: q.bid,
              ask: q.ask,
            });
          }
        }
        if (rows.length === 0) {
          return reject(operation, "UNKNOWN_SYMBOL", `No ${expiration} chain for ${underlying}`);
        }
        return Effect.succeed(
          rows.sort((a, b) => a.strike - b.strike || a.right.localeCompare(b.right)),
        );
      }),

    confirmOrder: (request) =>
      call("confirmOrder", (operation) =>
        Effect.map(validate(operation, request), (estimatedPriceMicros) => ({
          orderConfirmId: request.orderConfirmId,
          estimatedPriceMicros,
        })),
      ),

    placeOrder: (request) =>
      call("placeOrder", (operation) => {
        // A repeated OrderConfirmID returns the order it already made (verify against SIM).
        const existing = orderIdByConfirmId.get(request.orderConfirmId);
        if (existing !== undefined) return Effect.succeed({ orderId: existing });
        return Effect.map(validate(operation, request), (priceMicros) => {
          sequence += 1;
          const openedAt = now();
          const order: SimOrder = {
            orderId: `${config.seed}-${sequence}`,
            request,
            priceMicros,
            openedAt,
            filledQty: 0,
            closedAt: null,
            ended: null,
            schedule: scheduleFor(request.quantity, openedAt),
          };
          orders.set(order.orderId, order);
          orderIdByConfirmId.set(request.orderConfirmId, order.orderId);
          settle();
          return { orderId: order.orderId };
        });
      }),

    cancelOrder: (accountId, orderId) =>
      call("cancelOrder", (operation) => {
        const order = orders.get(orderId);
        if (order === undefined || order.request.accountId !== accountId) {
          return reject(operation, "ORDER_NOT_FOUND", `Unknown order ${orderId}`);
        }
        if (statusOf(order) === "FILLED" || order.ended !== null) {
          return reject(operation, "ORDER_NOT_CANCELABLE", `Order ${orderId} is already closed`);
        }
        order.ended = "CANCELED";
        order.closedAt = now();
        order.schedule = [];
        return Effect.succeed({ orderId });
      }),

    orders: (accountIds) =>
      call("orders", (operation) =>
        Effect.as(
          knownAccounts(operation, accountIds),
          [...orders.values()]
            .filter((o) => accountIds.includes(o.request.accountId))
            .map(toBrokerOrder),
        ),
      ),

    historicalOrders: (accountIds, since) =>
      call("historicalOrders", (operation) =>
        Effect.as(
          knownAccounts(operation, accountIds),
          [...orders.values()]
            .filter((o) => accountIds.includes(o.request.accountId))
            .map(toBrokerOrder)
            .filter((o) => o.closedAt !== null && o.closedAt >= since),
        ),
      ),

    positions: (accountIds) =>
      call("positions", (operation) => {
        const held: BrokerPosition[] = [];
        for (const p of positions.values()) {
          if (accountIds.includes(p.accountId)) {
            held.push({
              accountId: p.accountId,
              symbol: p.symbol,
              assetType: p.assetType,
              quantity: p.quantity,
              avgPriceMicros: p.avgPriceMicros,
            });
          }
        }
        return Effect.as(knownAccounts(operation, accountIds), held);
      }),
  };

  return {
    adapter,
    setFill: (next) => {
      fill = next;
    },
    setQuote: (symbol, update) => {
      const q = quotes.get(symbol);
      if (q !== undefined) Object.assign(q, update);
    },
  };
}

/** The BrokerAdapter service backed by one simulation. */
export function localSimLayer(sim: LocalSim): Layer.Layer<BrokerAdapter> {
  return Layer.succeed(BrokerAdapter, sim.adapter);
}

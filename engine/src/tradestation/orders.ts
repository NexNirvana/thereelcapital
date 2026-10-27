// Reading orders and positions (docs/tradestation-integration.md#endpoints-used). Orders: only
// single-leg long equity and option orders are representable; spreads and short sales made in
// another terminal are left out. Positions: shorts are reported with side "short" so the engine
// can see them and refuse to trade around them. Positions' P&L fields are never decoded (CLAUDE.md, never break).

import { sanitizeRejectReason } from "#lib/domain/reject-reason.ts";
import { Effect, Schema } from "effect";
import type {
  BrokerOrder,
  BrokerPosition,
  BrokerSkip,
  AssetType,
  TradeAction,
} from "../broker/adapter.ts";
import { Rejected, Unknown, type BrokerError, type BrokerOperation } from "../broker/errors.ts";
import type { Transport } from "./http.ts";
import { mapOrderStatus } from "./status.ts";
import {
  WireNumber,
  blankable,
  decodeWire,
  epochOf,
  failingField,
  integerOf,
  microsOf,
} from "./values.ts";

/** The docs recommend batches of 10 account ids (the endpoints take 1 to 25). */
const ACCOUNT_BATCH_SIZE = 10;

/** What is kept of the broker's rejection text. */

const AccountErrors = blankable(
  Schema.Array(
    Schema.Struct({ Error: blankable(Schema.String), Message: blankable(Schema.String) }),
  ),
);

const OrderLeg = Schema.Struct({
  Symbol: Schema.String,
  AssetType: Schema.String,
  BuyOrSell: Schema.String,
  OpenOrClose: blankable(Schema.String),
  QuantityOrdered: WireNumber,
  ExecQuantity: WireNumber,
  QuantityRemaining: WireNumber,
});

const WireOrder = Schema.Struct({
  OrderID: Schema.String.check(Schema.isMinLength(1)),
  AccountID: Schema.String,
  Status: Schema.String,
  OpenedDateTime: blankable(Schema.String),
  ClosedDateTime: blankable(Schema.String),
  FilledPrice: blankable(WireNumber),
  /** Present in the recorded SIM listings of rejected orders (sim/*); free text. (verify) in the spec. */
  RejectReason: blankable(Schema.String),
  Legs: Schema.Array(OrderLeg),
});

// The lists are decoded item by item (see `readOrders` and `positions`): the envelope only has to be a list.
const OrdersResponse = Schema.Struct({
  Orders: blankable(Schema.Array(Schema.Unknown)),
  Errors: AccountErrors,
  /** Present only when the answer is paginated; we never ask for pages, so it means truncation. */
  NextToken: blankable(Schema.String),
});

const WirePosition = Schema.Struct({
  AccountID: Schema.String,
  Symbol: Schema.String,
  AssetType: Schema.String,
  LongShort: Schema.String,
  Quantity: WireNumber,
  AveragePrice: WireNumber,
});

const PositionsResponse = Schema.Struct({
  Positions: blankable(Schema.Array(Schema.Unknown)),
  Errors: AccountErrors,
});

const text = (record: unknown, key: string): string | null => {
  if (typeof record !== "object" || record === null) return null;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : null;
};

/**
 * One order or position this client did not place (another app client on a shared account, or the
 * TradeStation terminal) may be shaped in a way the decoders refuse. It is left out and reported to
 * `skipped`; the sync loop decides whether that matters (it does when the item could be ours).
 */
const skip = (operation: BrokerSkip["operation"], item: unknown, field: string): BrokerSkip => ({
  operation,
  orderId: operation === "positions" ? null : text(item, "OrderID"),
  accountId: text(item, "AccountID"),
  symbol: text(item, "Symbol"),
  field,
});

const legField = (item: unknown): string => {
  const legs = typeof item === "object" && item !== null ? (item as { Legs?: unknown }).Legs : null;
  if (!Array.isArray(legs)) return "Legs";
  for (const leg of legs) {
    const field = failingField(OrderLeg, leg);
    if (field !== "item") return `Legs.${field}`;
  }
  return "Legs";
};

/** A partial answer would make reconciliation believe the other accounts are flat, so it fails. */
const failOnAccountErrors = (
  operation: BrokerOperation,
  errors: ReadonlyArray<{ Error?: string | null; Message?: string | null }> | null | undefined,
): Effect.Effect<void, BrokerError> => {
  const first = errors?.[0];
  return first === undefined
    ? Effect.void
    : Effect.fail(
        new Rejected({
          operation,
          code: first.Error ?? "ACCOUNT_ERROR",
          reason: (first.Message ?? "").slice(0, 200),
        }),
      );
};

const batches = (ids: ReadonlyArray<string>): string[] => {
  const result: string[] = [];
  for (let start = 0; start < ids.length; start += ACCOUNT_BATCH_SIZE) {
    result.push(ids.slice(start, start + ACCOUNT_BATCH_SIZE).join(","));
  }
  return result;
};

const tradeActionOf = (
  assetType: string,
  buyOrSell: string,
  openOrClose: string | null | undefined,
): { assetType: AssetType; tradeAction: TradeAction } | null => {
  const side = buyOrSell.toLowerCase();
  const effect = openOrClose?.toLowerCase();
  if (assetType === "STOCK") {
    if (side === "buy") return { assetType: "equity", tradeAction: "BUY" };
    if (side === "sell") return { assetType: "equity", tradeAction: "SELL" };
  }
  if (assetType === "STOCKOPTION") {
    if (side === "buy" && effect === "open")
      return { assetType: "option", tradeAction: "BUYTOOPEN" };
    if (side === "sell" && effect === "close")
      return { assetType: "option", tradeAction: "SELLTOCLOSE" };
  }
  return null;
};

const toBrokerOrder = (
  operation: BrokerOperation,
  order: typeof WireOrder.Type,
): Effect.Effect<BrokerOrder | null, BrokerError> =>
  Effect.gen(function* () {
    const leg = order.Legs[0];
    if (order.Legs.length !== 1 || leg === undefined) return null;
    const action = tradeActionOf(leg.AssetType, leg.BuyOrSell, leg.OpenOrClose);
    if (action === null) return null;
    const opened = order.OpenedDateTime ?? order.ClosedDateTime;
    if (opened == null) return yield* Effect.fail(invalid(operation, "OpenedDateTime"));
    const filledPrice = order.FilledPrice;
    return {
      orderId: order.OrderID,
      // The orders endpoints do not return OrderConfirmID (not in the spec): reconciliation
      // matches by OrderID, learned from the place response. The SIM orders listing does not echo it (sim/equity-order/orders-listing.json).
      orderConfirmId: null,
      accountId: order.AccountID,
      symbol: leg.Symbol,
      tradeAction: action.tradeAction,
      quantity: yield* integerOf(operation, "QuantityOrdered", leg.QuantityOrdered),
      filledQty: yield* integerOf(operation, "ExecQuantity", leg.ExecQuantity),
      remainingQty: yield* integerOf(operation, "QuantityRemaining", leg.QuantityRemaining),
      avgFillPriceMicros:
        filledPrice == null ? null : yield* microsOf(operation, "FilledPrice", filledPrice),
      status: mapOrderStatus(order.Status),
      rawStatus: order.Status,
      openedAt: yield* epochOf(operation, "OpenedDateTime", opened),
      closedAt:
        order.ClosedDateTime == null
          ? null
          : yield* epochOf(operation, "ClosedDateTime", order.ClosedDateTime),
      rejectReason: sanitizeRejectReason(order.RejectReason),
    };
  });

const invalid = (operation: BrokerOperation, field: string) =>
  new Unknown({ operation, detail: `invalid_value:${field}` });

const readOrders = (
  transport: Transport,
  operation: "orders" | "historicalOrders",
  accountIds: ReadonlyArray<string>,
  query: Readonly<Record<string, string>>,
  skipped: BrokerSkip[],
): Effect.Effect<ReadonlyArray<BrokerOrder>, BrokerError> =>
  Effect.gen(function* () {
    const pages = yield* Effect.forEach(batches(accountIds), (ids) =>
      Effect.gen(function* () {
        const path =
          operation === "orders"
            ? `/brokerage/accounts/${ids}/orders`
            : `/brokerage/accounts/${ids}/historicalorders`;
        const body = yield* transport.get(operation, path, query);
        const decoded = yield* decodeWire(operation, OrdersResponse, body);
        yield* failOnAccountErrors(operation, decoded.Errors);
        // A cut-off list would read as "these are all the orders" in reconciliation.
        if (decoded.NextToken != null && decoded.NextToken !== "") {
          return yield* Effect.fail(invalid(operation, "NextToken"));
        }
        const mapped: BrokerOrder[] = [];
        for (const item of decoded.Orders ?? []) {
          const wire = Schema.decodeUnknownResult(WireOrder)(item);
          if (wire._tag === "Failure") {
            const field = failingField(WireOrder, item);
            skipped.push(skip(operation, item, field === "Legs" ? legField(item) : field));
            continue;
          }
          const order = yield* Effect.result(toBrokerOrder(operation, wire.success));
          if (order._tag === "Failure") {
            const detail = order.failure._tag === "Unknown" ? order.failure.detail : "";
            skipped.push(skip(operation, item, detail.replace(/^invalid_value:/, "") || "item"));
          } else if (order.success !== null) {
            mapped.push(order.success);
          }
        }
        return mapped;
      }),
    );
    return pages.flat();
  });

/** Today's orders and open orders. No `pageSize`, so the broker returns up to 600 unpaginated. */
export const orders = (
  transport: Transport,
  accountIds: ReadonlyArray<string>,
  skipped: BrokerSkip[] = [],
) => readOrders(transport, "orders", accountIds, {}, skipped);

/** Closed orders from the UTC date of `since` (epoch ms). (verify) the 600-order cap and the date semantics. */
export const historicalOrders = (
  transport: Transport,
  accountIds: ReadonlyArray<string>,
  since: number,
  skipped: BrokerSkip[] = [],
) =>
  readOrders(
    transport,
    "historicalOrders",
    accountIds,
    { since: new Date(since).toISOString().slice(0, 10) },
    skipped,
  );

export const positions = (
  transport: Transport,
  accountIds: ReadonlyArray<string>,
  skipped: BrokerSkip[] = [],
): Effect.Effect<ReadonlyArray<BrokerPosition>, BrokerError> =>
  Effect.gen(function* () {
    const pages = yield* Effect.forEach(batches(accountIds), (ids) =>
      Effect.gen(function* () {
        const body = yield* transport.get("positions", `/brokerage/accounts/${ids}/positions`);
        const decoded = yield* decodeWire("positions", PositionsResponse, body);
        yield* failOnAccountErrors("positions", decoded.Errors);
        const result: BrokerPosition[] = [];
        for (const item of decoded.Positions ?? []) {
          const wire = Schema.decodeUnknownResult(WirePosition)(item);
          if (wire._tag === "Failure") {
            skipped.push(skip("positions", item, failingField(WirePosition, item)));
            continue;
          }
          const position = wire.success;
          const assetType: AssetType | null =
            position.AssetType === "STOCK"
              ? "equity"
              : position.AssetType === "STOCKOPTION"
                ? "option"
                : null;
          // Other asset classes are not representable and are left out. Shorts are reported.
          if (assetType === null) continue;
          const side = position.LongShort.toLowerCase();
          if (side !== "long" && side !== "short") {
            skipped.push(skip("positions", item, "LongShort"));
            continue;
          }
          const sized = yield* Effect.result(
            Effect.all({
              // Size is unsigned; the sign (if the broker sends one for shorts) lives in `side`.
              quantity: integerOf(
                "positions",
                "Quantity",
                String(position.Quantity).replace(/^-/, ""),
              ),
              avgPriceMicros: microsOf("positions", "AveragePrice", position.AveragePrice),
            }),
          );
          if (sized._tag === "Failure") {
            const detail = sized.failure._tag === "Unknown" ? sized.failure.detail : "";
            skipped.push(skip("positions", item, detail.replace(/^invalid_value:/, "") || "item"));
            continue;
          }
          result.push({
            accountId: position.AccountID,
            symbol: position.Symbol,
            assetType,
            side,
            ...sized.success,
          });
        }
        return result;
      }),
    );
    return pages.flat();
  });

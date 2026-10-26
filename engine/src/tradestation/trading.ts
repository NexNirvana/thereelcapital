// Order preview, placement and cancellation (docs/tradestation-integration.md#endpoints-used).
// Nothing here is ever retried: the transport's `send` makes one attempt, and a Timeout or Unknown
// means the order may exist (docs/order-lifecycle.md, rule 2). The product sends one kind of order,
// MARKET + DAY + Intelligent route + OrderConfirmID, and the request type has no field for more.
//
// SIM guard (CLAUDE.md, never real money): before any request that confirms, places or cancels
// an order, the account must be one the SIM API itself listed (TradeStation documents no
// SIM-account marker, so listing through the SIM host is the proof) and be an active Cash or
// Margin account. The base URL and mode were already proven when the transport was built.

import { Effect, Schema } from "effect";
import type {
  BrokerAccount,
  OrderPreview,
  OrderRequest,
  PlacedOrder,
  TradeAction,
} from "../broker/adapter.ts";
import { Rejected, Unknown, type BrokerError, type BrokerOperation } from "../broker/errors.ts";
import type { Transport } from "./http.ts";
import { accounts } from "./market.ts";
import { WireNumber, blankable, decodeWire, microsOf } from "./values.ts";

/** `OrderConfirmID` is limited to 22 characters by the spec. */
const MAX_ORDER_CONFIRM_ID_LENGTH = 22;

const ORDER_ID_PATTERN = /^\d+$/;

const EQUITY_ACTIONS: ReadonlySet<TradeAction> = new Set(["BUY", "SELL"]);
const OPTION_ACTIONS: ReadonlySet<TradeAction> = new Set(["BUYTOOPEN", "SELLTOCLOSE"]);

const refuse = (operation: BrokerOperation, code: string, reason: string) =>
  Effect.fail(new Rejected({ operation, code, reason }));

/** Accounts the SIM API listed, refreshed once when an unknown id shows up. */
export interface SimAccountGuard {
  readonly require: (
    operation: BrokerOperation,
    accountId: string,
  ) => Effect.Effect<void, BrokerError>;
}

export function makeSimAccountGuard(transport: Transport): SimAccountGuard {
  let known: ReadonlySet<string> = new Set();
  const tradable = (account: BrokerAccount) =>
    account.active && (account.kind === "Cash" || account.kind === "Margin");
  const refresh = accounts(transport).pipe(
    Effect.tap((list) =>
      Effect.sync(() => {
        known = new Set(list.filter(tradable).map((account) => account.accountId));
      }),
    ),
  );
  return {
    require: (operation, accountId) =>
      Effect.gen(function* () {
        if (known.has(accountId)) return;
        yield* refresh;
        if (!known.has(accountId)) {
          return yield* refuse(
            operation,
            "ACCOUNT_NOT_SIM",
            "account is not an active SIM Cash or Margin account",
          );
        }
      }),
  };
}

/** Everything about the request that can be checked without the network. */
function validate(operation: BrokerOperation, request: OrderRequest) {
  if (
    request.orderConfirmId === "" ||
    request.orderConfirmId.length > MAX_ORDER_CONFIRM_ID_LENGTH
  ) {
    return refuse(operation, "INVALID_ORDER_CONFIRM_ID", "must be 1 to 22 characters");
  }
  if (!Number.isSafeInteger(request.quantity) || request.quantity <= 0) {
    return refuse(operation, "INVALID_QUANTITY", "must be a positive integer");
  }
  if (request.symbol.trim() === "" || request.accountId.trim() === "") {
    return refuse(operation, "INVALID_ORDER", "symbol and account are required");
  }
  const allowed = request.assetType === "equity" ? EQUITY_ACTIONS : OPTION_ACTIONS;
  if (!allowed.has(request.tradeAction)) {
    return refuse(operation, "TRADE_ACTION_MISMATCH", request.tradeAction);
  }
  return Effect.void;
}

const orderBody = (request: OrderRequest, withConfirmId: boolean) => ({
  AccountID: request.accountId,
  Symbol: request.symbol,
  Quantity: String(request.quantity),
  OrderType: "Market",
  // Option actions are upper case: SIM accepted BUYTOOPEN (sim/option-order/place-upper.json).
  TradeAction: request.tradeAction,
  TimeInForce: { Duration: "DAY" },
  Route: "Intelligent",
  // Sending the id on orderconfirm does not reserve it on SIM (sim/equity-order/place.json); omitting it stays safer.
  ...(withConfirmId ? { OrderConfirmID: request.orderConfirmId } : {}),
});

const ConfirmResponse = Schema.Struct({
  Confirmations: Schema.Array(Schema.Struct({ EstimatedPrice: blankable(WireNumber) })),
});

export const confirmOrder = (
  transport: Transport,
  guard: SimAccountGuard,
  request: OrderRequest,
): Effect.Effect<OrderPreview, BrokerError> =>
  Effect.gen(function* () {
    yield* validate("confirmOrder", request);
    yield* guard.require("confirmOrder", request.accountId);
    const body = yield* transport.send(
      "confirmOrder",
      "POST",
      "/orderexecution/orderconfirm",
      orderBody(request, false),
    );
    const decoded = yield* decodeWire("confirmOrder", ConfirmResponse, body);
    const price = decoded.Confirmations[0]?.EstimatedPrice;
    if (price == null) {
      return yield* Effect.fail(
        new Unknown({ operation: "confirmOrder", detail: "invalid_response" }),
      );
    }
    return {
      orderConfirmId: request.orderConfirmId,
      estimatedPriceMicros: yield* microsOf("confirmOrder", "EstimatedPrice", price),
    };
  });

const OrderResult = Schema.Struct({
  OrderID: blankable(Schema.String),
  Error: blankable(Schema.String),
  Message: blankable(Schema.String),
});
const PlaceResponse = Schema.Struct({
  Orders: blankable(Schema.Array(OrderResult)),
  Errors: blankable(Schema.Array(OrderResult)),
});

export const placeOrder = (
  transport: Transport,
  guard: SimAccountGuard,
  request: OrderRequest,
): Effect.Effect<PlacedOrder, BrokerError> =>
  Effect.gen(function* () {
    yield* validate("placeOrder", request);
    yield* guard.require("placeOrder", request.accountId);
    const body = yield* transport.send(
      "placeOrder",
      "POST",
      "/orderexecution/orders",
      orderBody(request, true),
    );
    const decoded = yield* decodeWire("placeOrder", PlaceResponse, body);
    const placed = decoded.Orders?.find(
      (order) => order.OrderID != null && order.OrderID !== "" && (order.Error ?? "") === "",
    );
    if (placed?.OrderID != null) return { orderId: placed.OrderID };
    // HTTP 200 with only Errors is a refusal (spec example). An answer with neither is not
    // understood, so the order may exist: Unknown, never Rejected.
    const failure =
      decoded.Errors?.[0] ?? decoded.Orders?.find((order) => (order.Error ?? "") !== "");
    if (failure !== undefined) {
      return yield* refuse(
        "placeOrder",
        failure.Error != null && failure.Error !== "" ? failure.Error : "ORDER_REFUSED",
        (failure.Message ?? "").slice(0, 200),
      );
    }
    return yield* Effect.fail(new Unknown({ operation: "placeOrder", detail: "invalid_response" }));
  });

export const cancelOrder = (
  transport: Transport,
  guard: SimAccountGuard,
  accountId: string,
  orderId: string,
): Effect.Effect<PlacedOrder, BrokerError> =>
  Effect.gen(function* () {
    // Digits only, as the spec's example: also keeps the id from altering the request path.
    if (!ORDER_ID_PATTERN.test(orderId)) {
      return yield* refuse("cancelOrder", "INVALID_ORDER_ID", "must be digits only");
    }
    yield* guard.require("cancelOrder", accountId);
    const body = yield* transport.send(
      "cancelOrder",
      "DELETE",
      `/orderexecution/orders/${orderId}`,
    );
    const decoded = yield* decodeWire("cancelOrder", OrderResult, body);
    if (decoded.Error != null && decoded.Error !== "") {
      return yield* refuse("cancelOrder", decoded.Error, (decoded.Message ?? "").slice(0, 200));
    }
    return { orderId: decoded.OrderID ?? orderId };
  });

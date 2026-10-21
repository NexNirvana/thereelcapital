// Order guards and entry/slot limits. See docs/domain-rules.md §3, §4 and §5.
// Pure functions: the caller supplies `now`, the account, `available` and the open symbols.

import { isRegularSession } from "./calendar";

/** docs/domain-rules.md §3: entries per client, mode and market session date. */
export const MAX_DAILY_ENTRIES = 3;
/** docs/domain-rules.md §4: open positions per client and mode. */
export const MAX_OPEN_POSITIONS = 2;

export type RejectionReason =
  | "MODE_NOT_SIM"
  | "ACCOUNT_NOT_OWNED"
  | "ACCOUNT_NOT_ACTIVE"
  | "ACCOUNT_TYPE_NOT_ALLOWED"
  | "INSTRUMENT_OUT_OF_SCOPE"
  | "ORDER_TYPE_NOT_MARKET"
  | "TRADE_ACTION_NOT_ALLOWED"
  | "QUANTITY_INVALID"
  | "SELL_EXCEEDS_AVAILABLE"
  | "OUTSIDE_REGULAR_SESSION"
  | "POSITION_ALREADY_OPEN";

export type GuardResult = { readonly ok: true } | { readonly ok: false; readonly reason: RejectionReason };

export type InstrumentRequest =
  | { readonly kind: "equity"; readonly symbol: string }
  | { readonly kind: "option"; readonly symbol: string; readonly legs: number }
  | { readonly kind: "future" | "spread"; readonly symbol: string };

export interface OrderRequest {
  readonly mode: "SIM" | "REAL";
  readonly accountId: string;
  readonly instrument: InstrumentRequest;
  readonly orderType: string;
  readonly tradeAction: string;
  readonly quantity: number;
}

export interface OrderContext {
  readonly clientId: string;
  readonly account: {
    readonly id: string;
    readonly clientId: string;
    readonly type: string;
    readonly active: boolean;
  };
  /** Sellable quantity of the position: original − sold − committed (integer). */
  readonly available: number;
  /** Symbols with an open position for this client and mode. */
  readonly openSymbols: readonly string[];
  readonly now: Date;
}

const ALLOWED_ACCOUNT_TYPES: readonly string[] = ["Cash", "Margin"];

const ALLOWED_ACTIONS = {
  equity: { open: "BUY", close: "SELL" },
  option: { open: "BUYTOOPEN", close: "SELLTOCLOSE" },
} as const;

const reject = (reason: RejectionReason): GuardResult => ({ ok: false, reason });

export function checkOrder(request: OrderRequest, context: OrderContext): GuardResult {
  const { instrument } = request;
  const { account } = context;

  if (request.mode !== "SIM") return reject("MODE_NOT_SIM");
  if (account.id !== request.accountId || account.clientId !== context.clientId) {
    return reject("ACCOUNT_NOT_OWNED");
  }
  if (!account.active) return reject("ACCOUNT_NOT_ACTIVE");
  if (!ALLOWED_ACCOUNT_TYPES.includes(account.type)) return reject("ACCOUNT_TYPE_NOT_ALLOWED");

  if (instrument.kind !== "equity" && !(instrument.kind === "option" && instrument.legs === 1)) {
    return reject("INSTRUMENT_OUT_OF_SCOPE");
  }
  if (request.orderType !== "Market") return reject("ORDER_TYPE_NOT_MARKET");

  const actions = ALLOWED_ACTIONS[instrument.kind];
  const isOpening = request.tradeAction === actions.open;
  const isClosing = request.tradeAction === actions.close;
  if (!isOpening && !isClosing) return reject("TRADE_ACTION_NOT_ALLOWED");

  if (!Number.isSafeInteger(request.quantity) || request.quantity <= 0) return reject("QUANTITY_INVALID");

  if (isClosing && request.quantity > context.available) return reject("SELL_EXCEEDS_AVAILABLE");

  if (!isRegularSession(instrument, context.now).open) return reject("OUTSIDE_REGULAR_SESSION");

  // Interim rule while additions are undefined (docs/domain-rules.md §9).
  if (isOpening && context.openSymbols.includes(instrument.symbol)) return reject("POSITION_ALREADY_OPEN");

  return { ok: true };
}

/** docs/domain-rules.md §3. Entries only: exits never call this. */
export function canReserveEntry(counters: { consumed: number; reserved: number }): boolean {
  return counters.consumed + counters.reserved < MAX_DAILY_ENTRIES;
}

/** docs/domain-rules.md §4. Entries only: exits never call this. */
export function canReserveSlot(counters: { open: number; reservedOpens: number }): boolean {
  return counters.open + counters.reservedOpens < MAX_OPEN_POSITIONS;
}

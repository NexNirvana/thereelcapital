// The spike steps. Each one answers specific (verify) items from docs/tradestation-integration.md
// and open questions 6 to 12, prints OBSERVED/PASS/FAIL lines and leaves samples via the client.
// Orders are tiny (1 share or 1 contract), always closed again, and only go through client.order().
import type { InstrumentKind } from "#lib/domain/calendar.ts";
import { sessionDate } from "#lib/domain/calendar.ts";
import { mapOrderStatus } from "../../engine/src/tradestation/status.ts";
import { SpikeAbort, field, type Reply, type SimClient } from "./client.ts";
import type { Findings } from "./findings.ts";
import type { TokenSession } from "./oauth.ts";
import { maskAccount } from "./redact.ts";

export interface StepContext {
  readonly client: SimClient;
  readonly session: TokenSession;
  readonly findings: Findings;
  readonly symbol: string;
  readonly accountOption: string | undefined;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  /** Filled by earlier steps in the same run so later ones can reuse them. */
  readonly shared: {
    account?: string;
    optionSymbol?: string;
    optionBid?: number;
    optionAsk?: number;
    lastPrice?: number;
  };
}

export type Step = (ctx: StepContext) => Promise<void>;

const list = (value: unknown, key: string): unknown[] => {
  const inner = field(value, key);
  return Array.isArray(inner) ? inner : [];
};
const text = (value: unknown, key: string): string => {
  const inner = field(value, key);
  return inner === undefined || inner === null ? "" : String(inner);
};
const num = (value: unknown, key: string): number => Number(text(value, key));
const keysOf = (value: unknown): string =>
  value !== null && typeof value === "object" ? Object.keys(value).join(",") : "(none)";
/** OrderConfirmID is limited to 22 characters by the spec. */
const newConfirmId = () => `spk${crypto.randomUUID().replaceAll("-", "").slice(0, 19)}`;

// ---------------------------------------------------------------- shared helpers

async function simAccount(ctx: StepContext, step: string): Promise<string> {
  if (ctx.shared.account !== undefined) return ctx.shared.account;
  const reply = await ctx.client.loadAccounts(step);
  const candidates = [...ctx.client.simAccounts].filter(
    ([, info]) => info.status === "Active" && (info.type === "Cash" || info.type === "Margin"),
  );
  const wanted = ctx.accountOption;
  const chosen =
    wanted === undefined
      ? candidates[0]?.[0]
      : candidates.find(([id]) => id === wanted || id.endsWith(wanted))?.[0];
  if (reply.status !== 200 || chosen === undefined) {
    throw new SpikeAbort("No active Cash/Margin account in the SIM accounts list (use --account).");
  }
  ctx.shared.account = chosen;
  return chosen;
}

async function lastPrice(ctx: StepContext, step: string): Promise<number> {
  const reply = await ctx.client.get(step, "quote-equity", `/marketdata/quotes/${ctx.symbol}`);
  const quote = list(reply.body, "Quotes")[0];
  const price = num(quote, "Last") || num(quote, "Ask");
  if (!(price > 0)) throw new SpikeAbort(`No price for ${ctx.symbol}.`);
  ctx.shared.lastPrice = price;
  return price;
}

async function positionQty(
  ctx: StepContext,
  step: string,
  account: string,
  symbol: string,
  name: string,
) {
  const reply = await ctx.client.get(step, name, `/brokerage/accounts/${account}/positions`);
  const row = list(reply.body, "Positions").find((position) => text(position, "Symbol") === symbol);
  if (row === undefined) return 0;
  const sign = text(row, "LongShort").toLowerCase() === "short" ? -1 : 1;
  return sign * Math.abs(num(row, "Quantity"));
}

/** Terminal per the adapter's documented status table. */
const isTerminal = (status: string) =>
  ["FILLED", "CANCELED", "REJECTED"].includes(mapOrderStatus(status));

async function orderRow(
  ctx: StepContext,
  step: string,
  account: string,
  orderId: string,
  name: string,
) {
  const reply = await ctx.client.get(step, name, `/brokerage/accounts/${account}/orders`);
  return list(reply.body, "Orders").find((order) => text(order, "OrderID") === orderId);
}

/** Polls the orders listing until the order is terminal or the time is up. */
async function settle(
  ctx: StepContext,
  step: string,
  account: string,
  orderId: string,
  name: string,
) {
  let row = await orderRow(ctx, step, account, orderId, name);
  for (let attempt = 0; attempt < 10 && !isTerminal(text(row, "Status")); attempt += 1) {
    await ctx.sleep(1000);
    row = await orderRow(ctx, step, account, orderId, name);
  }
  return row;
}

function placedOrderId(reply: Reply): string | undefined {
  const placed = list(reply.body, "Orders").find((order) => text(order, "OrderID") !== "");
  return placed === undefined ? undefined : text(placed, "OrderID");
}

const briefReply = (reply: Reply) =>
  `status ${reply.status}, body keys ${keysOf(reply.body)}, ${JSON.stringify(reply.body).slice(0, 220)}`;

interface PlaceArgs {
  account: string;
  symbol: string;
  kind: InstrumentKind;
  action: string;
  quantity: number;
  confirmId?: string;
  extra?: Record<string, unknown>;
  orderType?: string;
}

function orderBody(args: PlaceArgs) {
  return {
    AccountID: args.account,
    Symbol: args.symbol,
    Quantity: String(args.quantity),
    OrderType: args.orderType ?? "Market",
    TradeAction: args.action,
    TimeInForce: { Duration: "DAY" },
    Route: "Intelligent",
    ...(args.confirmId === undefined ? {} : { OrderConfirmID: args.confirmId }),
    ...args.extra,
  };
}

const place = (ctx: StepContext, step: string, name: string, args: PlaceArgs) =>
  ctx.client.order(step, name, {
    method: "POST",
    path: "/orderexecution/orders",
    body: orderBody(args),
    accountId: args.account,
    kind: args.kind,
  });

const confirm = (ctx: StepContext, step: string, name: string, args: PlaceArgs) =>
  ctx.client.order(step, name, {
    method: "POST",
    path: "/orderexecution/orderconfirm",
    body: orderBody(args),
    accountId: args.account,
    kind: args.kind,
  });

const cancel = (
  ctx: StepContext,
  step: string,
  name: string,
  account: string,
  orderId: string,
  kind: InstrumentKind,
) =>
  ctx.client.order(step, name, {
    method: "DELETE",
    path: `/orderexecution/orders/${orderId}`,
    accountId: account,
    kind,
  });

/** Sells (or buys back) whatever this step added, so the account ends as it started. */
async function flatten(
  ctx: StepContext,
  step: string,
  args: {
    account: string;
    symbol: string;
    kind: InstrumentKind;
    before: number;
    sellAction: string;
    name: string;
  },
) {
  const after = await positionQty(
    ctx,
    step,
    args.account,
    args.symbol,
    `${args.name}-positions-before-close`,
  );
  const added = after - args.before;
  if (added <= 0) {
    ctx.findings.add(step, "close", "OBSERVED", `nothing to close (position change ${added})`);
    return;
  }
  const reply = await place(ctx, step, `${args.name}-close`, {
    account: args.account,
    symbol: args.symbol,
    kind: args.kind,
    action: args.sellAction,
    quantity: added,
    confirmId: newConfirmId(),
  });
  const id = placedOrderId(reply);
  if (id !== undefined) await settle(ctx, step, args.account, id, `${args.name}-close-order`);
  const end = await positionQty(
    ctx,
    step,
    args.account,
    args.symbol,
    `${args.name}-positions-after-close`,
  );
  ctx.findings.add(
    step,
    "positions after close",
    end === args.before ? "PASS" : "FAIL",
    `quantity before ${args.before}, after close ${end}`,
  );
}

// ---------------------------------------------------------------- steps

export const accountsStep: Step = async (ctx) => {
  const step = "accounts";
  const reply = await ctx.client.loadAccounts(step);
  const rows = list(reply.body, "Accounts");
  ctx.findings.add(
    step,
    "GET /brokerage/accounts on the SIM host",
    reply.status === 200 ? "PASS" : "FAIL",
    `status ${reply.status}, ${rows.length} accounts`,
  );
  for (const row of rows) {
    const id = text(row, "AccountID");
    ctx.findings.add(
      step,
      "Q7 how SIM accounts are identified",
      "OBSERVED",
      `AccountID ${maskAccount(id)} (length ${id.length}, prefix pattern ${id
        .replace(/\d/g, "9")
        .replace(/[A-Za-z]/g, "A")
        .slice(
          0,
          3,
        )}...), type ${text(row, "AccountType")}, status ${text(row, "Status")}, fields ${keysOf(row)}`,
    );
  }
  ctx.findings.add(
    step,
    "Q7 one token for SIM and LIVE",
    "NOT_TESTED",
    "forbidden by the SIM-only rule: the live host is never contacted",
  );
};

export const refreshStep: Step = async (ctx) => {
  const step = "refresh";
  await ctx.session.refresh(step);
  const info = ctx.session.lastRefresh;
  ctx.findings.add(
    step,
    "Q6 refresh grant works",
    "PASS",
    `new access token, expires_in ${info?.expiresIn}`,
  );
  ctx.findings.add(
    step,
    "Q6 key rotates refresh tokens",
    "OBSERVED",
    info?.rotated === true
      ? "yes: a new refresh_token came back (replaced in memory)"
      : "no: the response carried no new refresh_token",
  );
  const refused = await ctx.session.probeRefusedRefresh(step);
  ctx.findings.add(
    step,
    "Q6 status and body of a refused refresh",
    "OBSERVED",
    briefReply(refused),
  );
  ctx.findings.add(
    step,
    "Q6 error at absolute refresh-token expiry",
    "NOT_OBSERVABLE",
    "needs the 24 h lifetime to pass; re-check the refresh tomorrow if the owner keeps a session",
  );
};

export const quotesStep: Step = async (ctx) => {
  const step = "quotes";
  const reply = await ctx.client.get(step, "quote-equity", `/marketdata/quotes/${ctx.symbol}`);
  const quote = list(reply.body, "Quotes")[0];
  ctx.findings.add(
    step,
    "equity quote snapshot",
    reply.status === 200 && quote !== undefined ? "PASS" : "FAIL",
    `fields ${keysOf(quote)}; Bid ${text(quote, "Bid")} Ask ${text(quote, "Ask")}; MarketFlags ${JSON.stringify(field(quote, "MarketFlags"))}`,
  );
  const option = await pickOption(ctx, step);
  const optionReply = await ctx.client.get(
    step,
    "quote-option",
    `/marketdata/quotes/${encodeURIComponent(option.symbol)}`,
  );
  const optionQuote = list(optionReply.body, "Quotes")[0];
  const errors = list(optionReply.body, "Errors");
  ctx.findings.add(
    step,
    "Q8 option quotes through /marketdata/quotes",
    optionQuote !== undefined && errors.length === 0 ? "PASS" : "FAIL",
    `${option.symbol}: status ${optionReply.status}, quote fields ${keysOf(optionQuote)}, Bid ${text(optionQuote, "Bid")} Ask ${text(optionQuote, "Ask")}, errors ${JSON.stringify(errors).slice(0, 200)}`,
  );
};

export const symbolsStep: Step = async (ctx) => {
  const step = "symbols";
  const equity = await ctx.client.get(step, "symbol-equity", `/marketdata/symbols/${ctx.symbol}`);
  const row = list(equity.body, "Symbols")[0];
  ctx.findings.add(
    step,
    "equity symbol details",
    equity.status === 200 ? "PASS" : "FAIL",
    `PriceFormat ${JSON.stringify(field(row, "PriceFormat"))}, QuantityFormat ${JSON.stringify(field(row, "QuantityFormat"))}, MinimumTradeQuantity ${text(row, "MinimumTradeQuantity")}`,
  );
  const option = await pickOption(ctx, step);
  const reply = await ctx.client.get(
    step,
    "symbol-option",
    `/marketdata/symbols/${encodeURIComponent(option.symbol)}`,
  );
  const optionRow = list(reply.body, "Symbols")[0];
  ctx.findings.add(
    step,
    "Q9 option PointValue (expected 100)",
    "OBSERVED",
    `${option.symbol}: PointValue ${text(field(optionRow, "PriceFormat"), "PointValue")}, AssetType ${text(optionRow, "AssetType")}, fields ${keysOf(optionRow)}`,
  );
};

export const expirationsStep: Step = async (ctx) => {
  const step = "expirations";
  const expirations = await ctx.client.get(
    step,
    "expirations",
    `/marketdata/options/expirations/${ctx.symbol}`,
  );
  const dates = list(expirations.body, "Expirations");
  ctx.findings.add(
    step,
    "expirations format",
    expirations.status === 200 ? "OBSERVED" : "FAIL",
    `${dates.length} rows, first ${JSON.stringify(dates[0])}`,
  );
  const first = pickExpiration(dates, ctx.now());
  if (first === undefined) throw new SpikeAbort("No usable expiration.");
  const strikes = await ctx.client.get(
    step,
    "strikes-single",
    `/marketdata/options/strikes/${ctx.symbol}`,
    { expiration: first, spreadType: "Single" },
  );
  ctx.findings.add(
    step,
    "spreadType=Single and plain-date expiration accepted by strikes",
    strikes.status === 200 ? "PASS" : "FAIL",
    `expiration ${first}: status ${strikes.status}, ${list(strikes.body, "Strikes").length} strikes, first ${JSON.stringify(list(strikes.body, "Strikes")[0])}`,
  );
};

export const chainStep: Step = async (ctx) => {
  const step = "chain";
  const expirations = await ctx.client.get(
    step,
    "expirations",
    `/marketdata/options/expirations/${ctx.symbol}`,
  );
  const expiration = pickExpiration(list(expirations.body, "Expirations"), ctx.now());
  if (expiration === undefined) throw new SpikeAbort("No usable expiration.");
  const query = new URLSearchParams({
    expiration,
    spreadType: "Single",
    optionType: "All",
    enableGreeks: "false",
  });
  const { status, messages } = await ctx.client.stream(
    step,
    "chain-stream",
    `/marketdata/stream/options/chains/${ctx.symbol}?${query.toString()}`,
    (message) => text(message, "StreamStatus") === "EndSnapshot",
    30_000,
  );
  const rows = messages.filter((message) => list(message, "Legs").length > 0);
  const others = messages.filter((message) => list(message, "Legs").length === 0);
  const ended = messages.some((message) => text(message, "StreamStatus") === "EndSnapshot");
  ctx.findings.add(
    step,
    "chain stream until EndSnapshot",
    status === 200 && ended ? "PASS" : "FAIL",
    `status ${status}, ${rows.length} chain rows before the end, non-row messages: ${others
      .map((message) => keysOf(message))
      .slice(0, 4)
      .join(" | ")}`,
  );
  ctx.findings.add(
    step,
    "default strikeProximity of the chain",
    "OBSERVED",
    `${rows.length} rows without strikeProximity for ${expiration}`,
  );
};

export const rateLimitsStep: Step = async (ctx) => {
  const step = "rate-limits";
  for (let i = 0; i < 3; i += 1) await ctx.client.get(step, `probe-${i}`, "/brokerage/accounts");
  const seen = [...ctx.client.rateLimitHeaders].map(([name, value]) => `${name}=${value}`);
  ctx.findings.add(
    step,
    "Q12 rate-limit headers",
    "OBSERVED",
    seen.length > 0 ? seen.join("; ") : "no X-RateLimit-* headers seen",
  );
};

export const confirmStep: Step = async (ctx) => {
  const step = "confirm";
  const account = await simAccount(ctx, step);
  const price = await lastPrice(ctx, step);
  const args: PlaceArgs = {
    account,
    symbol: ctx.symbol,
    kind: "equity",
    action: "BUY",
    quantity: 1,
  };
  const without = await confirm(ctx, step, "orderconfirm-without-id", args);
  ctx.findings.add(
    step,
    "orderconfirm response",
    without.status === 200 ? "PASS" : "FAIL",
    briefReply(without),
  );
  const withId = await confirm(ctx, step, "orderconfirm-with-id", {
    ...args,
    confirmId: newConfirmId(),
  });
  ctx.findings.add(
    step,
    "orderconfirm accepts OrderConfirmID",
    withId.status === 200 ? "PASS" : "FAIL",
    `${briefReply(withId)} (last ${price})`,
  );
};

export const equityOrderStep: Step = async (ctx) => {
  const step = "equity-order";
  const account = await simAccount(ctx, step);
  const symbol = ctx.symbol;
  const before = await positionQty(ctx, step, account, symbol, "positions-before");
  const confirmId = newConfirmId();
  const args: PlaceArgs = {
    account,
    symbol,
    kind: "equity",
    action: "BUY",
    quantity: 1,
    confirmId,
  };
  try {
    await confirm(ctx, step, "orderconfirm-with-id", args);
    const first = await place(ctx, step, "place", args);
    const firstId = placedOrderId(first);
    ctx.findings.add(
      step,
      "place MARKET DAY with OrderConfirmID, directly after orderconfirm with the same id",
      firstId !== undefined ? "PASS" : "FAIL",
      `Q: does orderconfirm reserve the id? ${briefReply(first)}`,
    );
    if (firstId === undefined) return;
    const second = await place(ctx, step, "place-duplicate", args);
    const secondId = placedOrderId(second);
    ctx.findings.add(
      step,
      "duplicate OrderConfirmID resend",
      "OBSERVED",
      secondId === undefined
        ? `refused: ${briefReply(second)}`
        : secondId === firstId
          ? `same OrderID returned (idempotent): ${briefReply(second)}`
          : `a SECOND order was created: ${briefReply(second)}`,
    );
    const row = await settle(ctx, step, account, firstId, "orders-listing");
    ctx.findings.add(
      step,
      "final status of the 1-share MARKET order",
      "OBSERVED",
      `Status ${text(row, "Status")} (${text(row, "StatusDescription")}), FilledPrice ${text(row, "FilledPrice")}`,
    );
    const echoed = JSON.stringify(row ?? {}).includes(confirmId);
    ctx.findings.add(
      step,
      "orders listing echoes OrderConfirmID",
      "OBSERVED",
      `${echoed ? "yes" : "no"}; order fields ${keysOf(row)}`,
    );
    if (!echoed && row !== undefined) {
      ctx.findings.add(
        step,
        "fallback match (account, symbol, action, quantity, open time)",
        "OBSERVED",
        `OpenedDateTime ${text(row, "OpenedDateTime")}, leg ${JSON.stringify(list(row, "Legs")[0] ?? null).slice(0, 300)}`,
      );
    }
  } finally {
    await flatten(ctx, step, {
      account,
      symbol,
      kind: "equity",
      before,
      sellAction: "SELL",
      name: "equity",
    });
  }
};

export const cancelRaceStep: Step = async (ctx) => {
  const step = "cancel-race";
  const account = await simAccount(ctx, step);
  const symbol = ctx.symbol;
  const before = await positionQty(ctx, step, account, symbol, "positions-before");
  try {
    const placed = await place(ctx, step, "place", {
      account,
      symbol,
      kind: "equity",
      action: "BUY",
      quantity: 1,
      confirmId: newConfirmId(),
    });
    const id = placedOrderId(placed);
    if (id === undefined) {
      ctx.findings.add(
        step,
        "cancel racing a fill",
        "FAIL",
        `place gave no OrderID: ${briefReply(placed)}`,
      );
      return;
    }
    const cancelled = await cancel(ctx, step, "cancel", account, id, "equity");
    const row = await settle(ctx, step, account, id, "orders-after-cancel");
    ctx.findings.add(
      step,
      "cancel racing a fill",
      "OBSERVED",
      `DELETE answered ${briefReply(cancelled)}; the order ended ${text(row, "Status")} (${text(row, "StatusDescription")})`,
    );
  } finally {
    await flatten(ctx, step, {
      account,
      symbol,
      kind: "equity",
      before,
      sellAction: "SELL",
      name: "cancel-race",
    });
  }
};

export const fillFieldsStep: Step = async (ctx) => {
  const step = "fill-fields";
  const account = await simAccount(ctx, step);
  const reply = await ctx.client.get(step, "orders-today", `/brokerage/accounts/${account}/orders`);
  const orders = list(reply.body, "Orders");
  const seen = new Set(orders.map((order) => text(order, "Status")));
  const leg = list(orders[0], "Legs")[0];
  ctx.findings.add(
    step,
    "status and leg fields",
    "OBSERVED",
    `${orders.length} orders today, statuses ${[...seen].join(",")}; order fields ${keysOf(orders[0])}; leg fields ${keysOf(leg)}`,
  );
  ctx.findings.add(
    step,
    "partial-fill representation (FLP, QuantityRemaining)",
    "NOT_OBSERVABLE",
    "SIM fills 1-share orders at once; a partial fill is not forced, so only the field names above are known",
  );
};

export const optionOrderStep: Step = async (ctx) => {
  const step = "option-order";
  const account = await simAccount(ctx, step);
  const option = await pickOption(ctx, step);
  const before = await positionQty(ctx, step, account, option.symbol, "positions-before");
  let sell = "SELLTOCLOSE";
  try {
    let buy = "BUYTOOPEN";
    let reply = await place(ctx, step, "place-upper", {
      account,
      symbol: option.symbol,
      kind: "option",
      action: buy,
      quantity: 1,
      confirmId: newConfirmId(),
    });
    let id = placedOrderId(reply);
    ctx.findings.add(
      step,
      "Q9 option TradeAction BUYTOOPEN (upper case)",
      id !== undefined ? "PASS" : "FAIL",
      briefReply(reply),
    );
    if (id === undefined) {
      // Only after a clear refusal (no OrderID at all) is the other casing tried.
      buy = "BuyToOpen";
      sell = "SellToClose";
      reply = await place(ctx, step, "place-mixed", {
        account,
        symbol: option.symbol,
        kind: "option",
        action: buy,
        quantity: 1,
        confirmId: newConfirmId(),
      });
      id = placedOrderId(reply);
      ctx.findings.add(
        step,
        "Q9 option TradeAction BuyToOpen (mixed case)",
        id !== undefined ? "PASS" : "FAIL",
        briefReply(reply),
      );
    }
    if (id !== undefined) {
      const row = await settle(ctx, step, account, id, "orders-listing");
      ctx.findings.add(
        step,
        "option order final status",
        "OBSERVED",
        `${text(row, "Status")} (${text(row, "StatusDescription")}); leg ${JSON.stringify(list(row, "Legs")[0] ?? null).slice(0, 300)}`,
      );
    }
  } finally {
    await flatten(ctx, step, {
      account,
      symbol: option.symbol,
      kind: "option",
      before,
      sellAction: sell,
      name: "option",
    });
  }
};

export const stopsStep: Step = async (ctx) => {
  const step = "stops";
  const account = await simAccount(ctx, step);
  const option = await pickOption(ctx, step);
  const before = await positionQty(ctx, step, account, option.symbol, "positions-before");
  const working: string[] = [];
  try {
    const bought = await place(ctx, step, "buy", {
      account,
      symbol: option.symbol,
      kind: "option",
      action: "BUYTOOPEN",
      quantity: 1,
      confirmId: newConfirmId(),
    });
    const boughtId = placedOrderId(bought);
    if (boughtId === undefined) {
      ctx.findings.add(
        step,
        "StopMarket on an option",
        "FAIL",
        `could not open the option (try option-order first): ${briefReply(bought)}`,
      );
      return;
    }
    await settle(ctx, step, account, boughtId, "buy-order");
    // Far below the bid so the stop cannot trigger while we look at it.
    const stopPrice = Math.max(0.01, Math.floor(option.bid * 0.5 * 100) / 100).toFixed(2);
    const base = {
      account,
      symbol: option.symbol,
      kind: "option" as const,
      action: "SELLTOCLOSE",
      quantity: 1,
      orderType: "StopMarket",
    };
    const stop = await place(ctx, step, "stopmarket", {
      ...base,
      confirmId: newConfirmId(),
      extra: { StopPrice: stopPrice },
    });
    const stopId = placedOrderId(stop);
    if (stopId !== undefined) working.push(stopId);
    ctx.findings.add(
      step,
      "Q10 StopMarket on an option, regular session, DAY",
      stopId !== undefined ? "PASS" : "FAIL",
      `stop ${stopPrice}: ${briefReply(stop)}`,
    );
    if (stopId !== undefined) {
      const row = await settle(ctx, step, account, stopId, "stopmarket-listing");
      ctx.findings.add(
        step,
        "StopMarket status while working",
        "OBSERVED",
        `${text(row, "Status")} (${text(row, "StatusDescription")}), StopPrice ${text(row, "StopPrice")}`,
      );
      const cancelled = await cancel(ctx, step, "stopmarket-cancel", account, stopId, "option");
      ctx.findings.add(step, "cancel a working StopMarket", "OBSERVED", briefReply(cancelled));
      working.splice(working.indexOf(stopId), 1);
    }
    // (verify) the trailing shape: AdvancedOptions.TrailingStop with Percent, no StopPrice.
    const trail = await place(ctx, step, "trailing-stopmarket", {
      ...base,
      confirmId: newConfirmId(),
      extra: { AdvancedOptions: { TrailingStop: { Percent: "10" } } },
    });
    const trailId = placedOrderId(trail);
    if (trailId !== undefined) working.push(trailId);
    ctx.findings.add(
      step,
      "Q10 trailing StopMarket on an option (AdvancedOptions.TrailingStop.Percent)",
      trailId !== undefined ? "PASS" : "FAIL",
      briefReply(trail),
    );
    if (trailId !== undefined) {
      const row = await settle(ctx, step, account, trailId, "trailing-listing");
      ctx.findings.add(
        step,
        "trailing StopMarket status while working",
        "OBSERVED",
        `${text(row, "Status")} (${text(row, "StatusDescription")}); fields ${keysOf(row)}`,
      );
      const cancelled = await cancel(ctx, step, "trailing-cancel", account, trailId, "option");
      ctx.findings.add(
        step,
        "cancel a working trailing StopMarket",
        "OBSERVED",
        briefReply(cancelled),
      );
      working.splice(working.indexOf(trailId), 1);
    }
  } finally {
    // A stop left working would sell later; cancel anything still open before closing.
    for (const id of working) await cancel(ctx, step, "cleanup-cancel", account, id, "option");
    await flatten(ctx, step, {
      account,
      symbol: option.symbol,
      kind: "option",
      before,
      sellAction: "SELLTOCLOSE",
      name: "stops",
    });
  }
};

export const expiryStep: Step = (ctx) => {
  ctx.findings.add(
    "expiry",
    "Q11 option at expiry and the resulting positions",
    "NOT_OBSERVABLE",
    "needs a held option to expire; not possible in one session. Keep the safer design (close before expiry)",
  );
  return Promise.resolve();
};

/** Steps in run order. */
export const STEPS: ReadonlyArray<readonly [string, Step]> = [
  ["accounts", accountsStep],
  ["refresh", refreshStep],
  ["quotes", quotesStep],
  ["symbols", symbolsStep],
  ["expirations", expirationsStep],
  ["chain", chainStep],
  ["rate-limits", rateLimitsStep],
  ["confirm", confirmStep],
  ["equity-order", equityOrderStep],
  ["cancel-race", cancelRaceStep],
  ["option-order", optionOrderStep],
  ["stops", stopsStep],
  ["fill-fields", fillFieldsStep],
  ["expiry", expiryStep],
];

/** Steps that call /orderexecution and so need --confirm-sim-orders. */
export const ORDER_STEPS: ReadonlySet<string> = new Set([
  "confirm",
  "equity-order",
  "cancel-race",
  "option-order",
  "stops",
]);

// ---------------------------------------------------------------- option selection

/** First expiration at least 3 days out (New York date), as YYYY-MM-DD. */
export function pickExpiration(rows: readonly unknown[], now: Date): string | undefined {
  const limit = new Date(now.getTime() + 3 * 86_400_000);
  const cutoff = sessionDate(limit);
  return rows
    .map((row) => text(row, "Date").slice(0, 10))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= cutoff)
    .sort()[0];
}

/** The call closest to the money with a two-sided market, from the chain stream. */
export async function pickOption(
  ctx: StepContext,
  step: string,
): Promise<{ symbol: string; bid: number; ask: number }> {
  if (ctx.shared.optionSymbol !== undefined && ctx.shared.optionBid !== undefined) {
    return {
      symbol: ctx.shared.optionSymbol,
      bid: ctx.shared.optionBid,
      ask: ctx.shared.optionBid,
    };
  }
  const price = ctx.shared.lastPrice ?? (await lastPrice(ctx, step));
  const expirations = await ctx.client.get(
    step,
    "expirations",
    `/marketdata/options/expirations/${ctx.symbol}`,
  );
  const expiration = pickExpiration(list(expirations.body, "Expirations"), ctx.now());
  if (expiration === undefined) throw new SpikeAbort("No usable expiration.");
  const query = new URLSearchParams({
    expiration,
    spreadType: "Single",
    optionType: "Call",
    enableGreeks: "false",
  });
  const { messages } = await ctx.client.stream(
    step,
    "chain-for-pick",
    `/marketdata/stream/options/chains/${ctx.symbol}?${query.toString()}`,
    (message) => text(message, "StreamStatus") === "EndSnapshot",
    30_000,
  );
  const candidates = messages
    .map((message) => ({
      leg: list(message, "Legs")[0],
      bid: num(message, "Bid"),
      ask: num(message, "Ask"),
    }))
    .filter((row) => row.leg !== undefined && row.bid > 0 && row.ask > 0)
    .map((row) => ({
      symbol: text(row.leg, "Symbol"),
      strike: num(row.leg, "StrikePrice"),
      bid: row.bid,
      ask: row.ask,
    }))
    .sort((a, b) => Math.abs(a.strike - price) - Math.abs(b.strike - price));
  const best = candidates[0];
  if (best === undefined) throw new SpikeAbort("No call with a two-sided market in the chain.");
  ctx.shared.optionSymbol = best.symbol;
  ctx.shared.optionBid = best.bid;
  ctx.shared.optionAsk = best.ask;
  return best;
}

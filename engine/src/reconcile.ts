// Brings the DO's intents and positions in line with what the broker reports.
// docs/order-lifecycle.md#reconciliation. `reconcile` is ONE synchronous transaction over a
// snapshot that was read before it: there is no await between reading and writing the counters,
// the sell ledger or the positions (CLAUDE.md, never-break rule 6). It never calls the broker and
// never places or retries an order; it only records what the broker says.

import { sessionDate } from "#lib/domain/calendar.ts";
import { SCALE_OUT_STEPS } from "#lib/domain/scaleout.ts";
import { ORDER_MATCH_SKEW_MS, SEND_GRACE_MS } from "#lib/domain/config.ts";
import type { BrokerOrder, BrokerPosition, SymbolDetails } from "./broker/adapter.ts";
import { writeEvent, type EventLevel } from "./events.ts";

/** What was read from the broker for the client's accounts, before the transaction starts. */
export interface BrokerSnapshot {
  /** Open orders and the ones closed recently. */
  readonly orders: readonly BrokerOrder[];
  /** Closed orders from further back, read only when an intent could not be found in `orders`. */
  readonly historical: readonly BrokerOrder[];
  readonly positions: readonly BrokerPosition[];
  /** Symbol details of the options that become positions in this pass (contract data, point value). */
  readonly details: ReadonlyMap<string, SymbolDetails>;
}

/** Per-client protection percentages a new position stores (docs/domain-rules.md §7, §8). */
export interface ProtectionSettings {
  readonly stopPct: number;
  readonly trailingUnlockPct: number;
}

export interface ReconcileContext {
  readonly sql: SqlStorage;
  readonly storage: DurableObjectStorage;
  readonly now: number;
}

export interface ReconcileSummary {
  /** Intents that still cannot be tied to a broker order; they keep their reservations. */
  readonly unknownLeft: number;
}

type IntentState =
  | "ARMED"
  | "SENT"
  | "ACKNOWLEDGED"
  | "PARTIAL"
  | "FILLED"
  | "CANCEL_PENDING"
  | "CANCELED"
  | "REJECTED"
  | "UNKNOWN";

const TERMINAL: readonly IntentState[] = ["FILLED", "CANCELED", "REJECTED"];
const isTerminal = (state: IntentState) => TERMINAL.includes(state);

interface IntentRow extends Record<string, SqlStorageValue> {
  id: string;
  kind: "entry" | "exit" | "stop" | "trailing" | "cancel";
  account_id: string;
  position_id: string | null;
  symbol: string;
  asset_type: string;
  trade_action: string;
  qty: number;
  state: IntentState;
  order_confirm_id: string;
  broker_order_id: string | null;
  filled_qty: number;
  avg_fill_price: number | null;
  point_value: number | null;
  created_at: number;
  updated_at: number;
  source: "app" | "external";
}

interface PositionRow extends Record<string, SqlStorageValue> {
  id: string;
  account_id: string;
  symbol: string;
  original_qty: number;
  sold_qty: number;
}

export function log(
  ctx: ReconcileContext,
  level: EventLevel,
  type: string,
  data?: Record<string, unknown>,
): void {
  writeEvent(ctx.sql, ctx.now, { mode: "SIM", level, type, message: type, data });
}

/** For conditions that stay true across ticks: the first pass logs it, later ones stay quiet. */
export function logOnce(
  ctx: ReconcileContext,
  key: string,
  level: EventLevel,
  type: string,
  data?: Record<string, unknown>,
): void {
  const flag = `logged:${type}:${key}`;
  if (ctx.storage.kv.get(flag) !== undefined) return;
  ctx.storage.kv.put(flag, ctx.now);
  log(ctx, level, type, data);
}

const isEntryIntent = (intent: IntentRow) => intent.kind === "entry";

export function reconcile(
  ctx: ReconcileContext,
  snapshot: BrokerSnapshot,
  protection: ProtectionSettings,
): ReconcileSummary {
  return ctx.storage.transactionSync(() => {
    const orders = indexOrders(snapshot);
    const pending = ctx.sql
      .exec<IntentRow>(
        "SELECT * FROM intents WHERE mode = 'SIM' AND state NOT IN ('FILLED', 'CANCELED', 'REJECTED') ORDER BY created_at",
      )
      .toArray();

    const { matches, unresolvedCandidates } = matchIntents(ctx, pending, orders);
    for (const [intent, order] of matches) applyOrder(ctx, intent, order);
    adoptOrders(ctx, orders, matches, unresolvedCandidates);

    const created = createPositions(ctx, snapshot, protection);
    adoptPositions(ctx, snapshot, protection);
    syncPositions(ctx, snapshot, created);

    const unknownLeft = ctx.sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM intents WHERE mode = 'SIM' AND state = 'UNKNOWN'",
      )
      .one().n;
    return { unknownLeft };
  });
}

/** Open orders win over the same order read from history. */
function indexOrders(snapshot: BrokerSnapshot): Map<string, BrokerOrder> {
  const byId = new Map<string, BrokerOrder>();
  for (const order of [...snapshot.historical, ...snapshot.orders]) byId.set(order.orderId, order);
  return byId;
}

/** The state a broker status moves an intent to; null keeps the current one. */
function nextState(intent: IntentRow, order: BrokerOrder): IntentState | null {
  switch (order.status) {
    case "UNMAPPED":
      return null;
    case "ACKNOWLEDGED":
      // Never move backwards: a partial fill stays PARTIAL, a requested cancel stays pending.
      return intent.state === "PARTIAL" || intent.state === "CANCEL_PENDING"
        ? null
        : "ACKNOWLEDGED";
    case "PARTIAL":
      return intent.state === "CANCEL_PENDING" ? null : "PARTIAL";
    case "FILLED":
      return order.filledQty > 0 ? "FILLED" : null;
    case "CANCELED":
    case "REJECTED":
      return order.status;
  }
}

/**
 * Status and fills come only from the broker. Filled quantity never goes down, so a stale read
 * cannot undo a fill. A cancel that raced a fill ends as FILLED (or CANCELED with the fills it
 * got), never as a cancel that hides executed shares.
 */
function applyOrder(ctx: ReconcileContext, intent: IntentRow, order: BrokerOrder): void {
  const filledQty = Math.max(intent.filled_qty, order.filledQty);
  const state = nextState(intent, order) ?? intent.state;
  const avgFillPrice = order.avgFillPriceMicros ?? intent.avg_fill_price;
  if (order.status === "UNMAPPED") {
    logOnce(ctx, `${intent.id}:${order.rawStatus}`, "warn", "reconcile.status_unmapped", {
      intentId: intent.id,
      rawStatus: order.rawStatus,
    });
  } else if (order.status === "FILLED" && order.filledQty === 0) {
    logOnce(ctx, intent.id, "warn", "reconcile.fill_missing", { intentId: intent.id });
  }
  ctx.sql.exec(
    `UPDATE intents SET state = ?, broker_order_id = ?, filled_qty = ?, avg_fill_price = ?, updated_at = ?
      WHERE id = ?`,
    state,
    order.orderId,
    filledQty,
    avgFillPrice,
    ctx.now,
    intent.id,
  );
  if (state !== intent.state || filledQty !== intent.filled_qty) {
    log(ctx, "info", "reconcile.intent_updated", {
      intentId: intent.id,
      from: intent.state,
      to: state,
      filledQty,
    });
  }

  if (isEntryIntent(intent) && intent.source === "app" && intent.filled_qty === 0) {
    // The reservation is spent by the first fill and returned by a terminal state with none.
    if (filledQty > 0) settleReservation(ctx, intent, { consumed: true });
    else if (isTerminal(state)) settleReservation(ctx, intent, { consumed: false });
  }
  if (!isEntryIntent(intent) && intent.position_id !== null && filledQty > intent.filled_qty) {
    ctx.sql.exec(
      "UPDATE positions SET sold_qty = MIN(original_qty, sold_qty + ?) WHERE id = ?",
      filledQty - intent.filled_qty,
      intent.position_id,
    );
  }
}

/** docs/domain-rules.md §3. Counted on the market day the reservation was taken. */
function settleReservation(
  ctx: ReconcileContext,
  intent: IntentRow,
  outcome: { readonly consumed: boolean },
): void {
  ctx.sql.exec(
    `UPDATE entry_counters
        SET consumed = consumed + ?, reserved = MAX(reserved - 1, 0)
      WHERE mode = 'SIM' AND session_date = ?`,
    outcome.consumed ? 1 : 0,
    sessionDate(new Date(intent.created_at)),
  );
}

/**
 * A terminal entry that filled becomes a position whose `original_qty` is fixed here, from the
 * fills (docs/domain-rules.md §6). The scale-out steps are created with it, so a later pass or a
 * reconnect never resets them. Returns the ids created now.
 */
function createPositions(
  ctx: ReconcileContext,
  snapshot: BrokerSnapshot,
  protection: ProtectionSettings,
): Set<string> {
  const created = new Set<string>();
  const entries = ctx.sql
    .exec<IntentRow>(
      `SELECT * FROM intents
        WHERE mode = 'SIM' AND kind = 'entry' AND position_id IS NULL AND filled_qty > 0
          AND state IN ('FILLED', 'CANCELED', 'REJECTED')`,
    )
    .toArray();
  for (const entry of entries) {
    if (entry.avg_fill_price === null) {
      logOnce(ctx, entry.id, "warn", "reconcile.fill_price_missing", { intentId: entry.id });
      continue;
    }
    const open = ctx.sql
      .exec<{ id: string }>(
        "SELECT id FROM positions WHERE mode = 'SIM' AND symbol = ? AND status != 'CLOSED'",
        entry.symbol,
      )
      .toArray()[0];
    if (open !== undefined) {
      logOnce(ctx, entry.id, "error", "reconcile.position_conflict", {
        intentId: entry.id,
        positionId: open.id,
      });
      continue;
    }
    const positionId = crypto.randomUUID();
    insertPosition(ctx, protection, {
      id: positionId,
      accountId: entry.account_id,
      symbol: entry.symbol,
      pointValue: entry.point_value ?? 1,
      details: snapshot.details.get(entry.symbol),
      quantity: entry.filled_qty,
      avgEntryPrice: entry.avg_fill_price,
      source: entry.source,
      openedOn: sessionDate(new Date(entry.created_at)),
    });
    ctx.sql.exec("UPDATE intents SET position_id = ? WHERE id = ?", positionId, entry.id);
    created.add(positionId);
    log(ctx, "info", "reconcile.position_opened", {
      positionId,
      intentId: entry.id,
      originalQty: entry.filled_qty,
    });
  }
  return created;
}

function insertPosition(
  ctx: ReconcileContext,
  protection: ProtectionSettings,
  position: {
    readonly id: string;
    readonly accountId: string;
    readonly symbol: string;
    readonly pointValue: number;
    readonly details: SymbolDetails | undefined;
    readonly quantity: number;
    readonly avgEntryPrice: number;
    readonly source: "app" | "external";
    readonly openedOn: string;
  },
): void {
  const option = position.details?.option ?? null;
  // Nothing watches a stop yet, so protection starts as `none`; the stop monitor sets `verified`.
  ctx.sql.exec(
    `INSERT INTO positions
       (id, mode, account_id, symbol, underlying, expiry, strike, right, point_value, original_qty,
        sold_qty, avg_entry_price, stop_pct, trailing_unlock_pct, protection_state, status, opened_on,
        source)
     VALUES (?, 'SIM', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'none', 'OPEN', ?, ?)`,
    position.id,
    position.accountId,
    position.symbol,
    option?.underlying ?? null,
    option?.expiration ?? null,
    option?.strike ?? null,
    option?.right ?? null,
    position.details?.pointValue ?? position.pointValue,
    position.quantity,
    position.avgEntryPrice,
    protection.stopPct,
    protection.trailingUnlockPct,
    position.openedOn,
    position.source,
  );
  for (const [idx] of SCALE_OUT_STEPS.entries()) {
    ctx.sql.exec(
      "INSERT INTO scaleout_steps (position_id, mode, idx, state) VALUES (?, 'SIM', ?, 'available')",
      position.id,
      idx,
    );
  }
}

/**
 * The broker is the authority on what is held: a position closes only when it reports zero
 * remaining, and a smaller holding than ours is a sale made elsewhere. Both wait while an exit of
 * ours is still unresolved, because that exit's fill may simply not be applied yet.
 */
function syncPositions(
  ctx: ReconcileContext,
  snapshot: BrokerSnapshot,
  created: ReadonlySet<string>,
): void {
  const open = ctx.sql
    .exec<PositionRow>(
      "SELECT id, account_id, symbol, original_qty, sold_qty FROM positions WHERE mode = 'SIM' AND status != 'CLOSED'",
    )
    .toArray();
  for (const position of open) {
    if (created.has(position.id)) continue;
    const exitsInFlight = ctx.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM intents
          WHERE position_id = ? AND kind != 'entry'
            AND state NOT IN ('FILLED', 'CANCELED', 'REJECTED')`,
        position.id,
      )
      .one().n;
    if (exitsInFlight > 0) continue;
    const held =
      snapshot.positions.find(
        (candidate) =>
          candidate.side === "long" &&
          candidate.accountId === position.account_id &&
          candidate.symbol === position.symbol,
      )?.quantity ?? 0;
    const remaining = position.original_qty - position.sold_qty;
    if (held === 0) {
      ctx.sql.exec(
        "UPDATE positions SET status = 'CLOSED', sold_qty = original_qty WHERE id = ?",
        position.id,
      );
      log(ctx, "info", "reconcile.position_closed", { positionId: position.id });
    } else if (held < remaining) {
      ctx.sql.exec(
        "UPDATE positions SET sold_qty = original_qty - ? WHERE id = ?",
        held,
        position.id,
      );
      log(ctx, "warn", "reconcile.external_sale", {
        positionId: position.id,
        soldQty: position.original_qty - held,
      });
    } else if (held > remaining) {
      // Additions are not supported (domain-rules.md §9): only our own quantity is ever sold.
      logOnce(ctx, `${position.id}:${held}`, "warn", "reconcile.position_larger", {
        positionId: position.id,
        held,
        remaining,
      });
    }
  }
}

const ENTRY_ACTIONS: readonly string[] = ["BUY", "BUYTOOPEN"];
const EXIT_ACTIONS: readonly string[] = ["SELL", "SELLTOCLOSE"];
const isOpenOrder = (order: BrokerOrder) =>
  order.status === "ACKNOWLEDGED" || order.status === "PARTIAL";

/**
 * Intents whose request may have left without their OrderID coming back. ARMED is not one: it was
 * never sent, so no order can be its own and it takes no part in the fallback match.
 */
const MAY_HAVE_ORDER: readonly IntentState[] = ["SENT", "UNKNOWN"];

interface Matching {
  readonly matches: ReadonlyMap<IntentRow, BrokerOrder>;
  /** Orders that an unresolved intent might own: they are not external until it is resolved. */
  readonly unresolvedCandidates: ReadonlySet<string>;
}

/**
 * Finds the broker order of every pending intent: by `OrderID`, then `OrderConfirmID`, then (for an
 * intent that never learned its OrderID) the documented fallback match: same account, symbol,
 * action and quantity, opened after the intent was created. The fallback adopts an order only when
 * exactly one order fits and no other intent could claim it; with several or none the intent stays
 * UNKNOWN and holds its reservations, because guessing could double an entry or free a slot that a
 * live order still needs (docs/tradestation-integration.md, orders).
 */
function matchIntents(
  ctx: ReconcileContext,
  pending: readonly IntentRow[],
  orders: ReadonlyMap<string, BrokerOrder>,
): Matching {
  const byConfirmId = new Map<string, BrokerOrder>();
  for (const order of orders.values()) {
    if (order.orderConfirmId !== null) byConfirmId.set(order.orderConfirmId, order);
  }
  const matches = new Map<IntentRow, BrokerOrder>();
  const claimed = new Set<string>();
  const waiting: IntentRow[] = [];
  for (const intent of pending) {
    const byId = intent.broker_order_id === null ? undefined : orders.get(intent.broker_order_id);
    const order = byId ?? byConfirmId.get(intent.order_confirm_id);
    if (order !== undefined) {
      matches.set(intent, order);
      claimed.add(order.orderId);
      if (byId === undefined) {
        log(ctx, "info", "reconcile.confirm_match", {
          intentId: intent.id,
          orderId: order.orderId,
        });
      }
    } else if (intent.broker_order_id !== null) {
      // The broker no longer lists an order it acknowledged; it may be older than the history read.
      logOnce(ctx, intent.id, "warn", "reconcile.order_missing", {
        intentId: intent.id,
        orderId: intent.broker_order_id,
      });
    } else if (intent.state === "ARMED") {
      resolveUnmatched(ctx, intent);
    } else if (MAY_HAVE_ORDER.includes(intent.state)) {
      waiting.push(intent);
    }
  }

  const taken = new Set(
    ctx.sql
      .exec<{ broker_order_id: string }>(
        "SELECT broker_order_id FROM intents WHERE broker_order_id IS NOT NULL",
      )
      .toArray()
      .map((row) => row.broker_order_id),
  );
  const candidatesOf = new Map<IntentRow, BrokerOrder[]>(
    waiting.map((intent) => [
      intent,
      [...orders.values()].filter(
        (order) =>
          !claimed.has(order.orderId) &&
          !taken.has(order.orderId) &&
          order.orderConfirmId === null &&
          order.accountId === intent.account_id &&
          order.symbol === intent.symbol &&
          order.tradeAction === intent.trade_action &&
          order.quantity === intent.qty &&
          order.openedAt >= intent.created_at - ORDER_MATCH_SKEW_MS,
      ),
    ]),
  );
  const claimants = new Map<string, number>();
  for (const found of candidatesOf.values()) {
    for (const order of found)
      claimants.set(order.orderId, (claimants.get(order.orderId) ?? 0) + 1);
  }
  const unresolvedCandidates = new Set(claimants.keys());

  for (const [intent, found] of candidatesOf) {
    const [only] = found;
    if (only !== undefined && found.length === 1 && claimants.get(only.orderId) === 1) {
      matches.set(intent, only);
      log(ctx, "info", "reconcile.fallback_match", { intentId: intent.id, orderId: only.orderId });
    } else if (found.length > 0) {
      // Several orders fit, or several intents want the same one: never guess.
      logOnce(ctx, intent.id, "error", "reconcile.ambiguous", {
        intentId: intent.id,
        orderIds: found.map((order) => order.orderId),
      });
    } else {
      resolveUnmatched(ctx, intent);
    }
  }
  return { matches, unresolvedCandidates };
}

/** No broker order fits an intent that never learned its OrderID. */
function resolveUnmatched(ctx: ReconcileContext, intent: IntentRow): void {
  if (intent.state === "ARMED") {
    // ARMED is written and left for SENT in one synchronous step, so only a crash between the
    // reservation and the send leaves it: no request was made and nothing exists to wait for.
    ctx.sql.exec(
      "UPDATE intents SET state = 'REJECTED', updated_at = ? WHERE id = ?",
      ctx.now,
      intent.id,
    );
    if (isEntryIntent(intent) && intent.source === "app") {
      settleReservation(ctx, intent, { consumed: false });
    }
    log(ctx, "warn", "reconcile.armed_never_sent", { intentId: intent.id });
    return;
  }
  if (intent.state === "SENT") {
    // A recent SENT may still have its place request in flight; leave it to answer.
    if (ctx.now - intent.updated_at < SEND_GRACE_MS) return;
    ctx.sql.exec(
      "UPDATE intents SET state = 'UNKNOWN', updated_at = ? WHERE id = ?",
      ctx.now,
      intent.id,
    );
    log(ctx, "warn", "reconcile.sent_stale", { intentId: intent.id });
  }
  // Not found yet, and possibly never placed: keep the reservations and wait for a human.
  logOnce(ctx, intent.id, "error", "reconcile.unresolved", { intentId: intent.id });
}

/**
 * Open orders made outside REEL CAPITAL (another terminal) are recorded as external intents so
 * they count against slots and `available` (docs/order-lifecycle.md#reconciliation). Orders that
 * an unresolved intent of ours might own are left alone until it is resolved. Closed external
 * orders need no record: their effect is in the broker's positions.
 */
function adoptOrders(
  ctx: ReconcileContext,
  orders: ReadonlyMap<string, BrokerOrder>,
  matches: ReadonlyMap<IntentRow, BrokerOrder>,
  unresolvedCandidates: ReadonlySet<string>,
): void {
  const known = new Set(
    ctx.sql
      .exec<{ broker_order_id: string }>(
        "SELECT broker_order_id FROM intents WHERE broker_order_id IS NOT NULL",
      )
      .toArray()
      .map((row) => row.broker_order_id),
  );
  for (const order of orders.values()) {
    if (
      !isOpenOrder(order) ||
      known.has(order.orderId) ||
      unresolvedCandidates.has(order.orderId)
    ) {
      continue;
    }
    if ([...matches.values()].some((matched) => matched.orderId === order.orderId)) continue;
    const entry = ENTRY_ACTIONS.includes(order.tradeAction);
    const position = entry
      ? null
      : ctx.sql
          .exec<{ id: string }>(
            "SELECT id FROM positions WHERE mode = 'SIM' AND account_id = ? AND symbol = ? AND status != 'CLOSED'",
            order.accountId,
            order.symbol,
          )
          .toArray()[0];
    // A sell with no position of ours to sell from is none of our business.
    if (!entry && (!EXIT_ACTIONS.includes(order.tradeAction) || position === undefined)) continue;
    const id = crypto.randomUUID();
    ctx.sql.exec(
      `INSERT INTO intents
         (id, mode, kind, account_id, position_id, symbol, asset_type, trade_action, qty, state,
          order_confirm_id, broker_order_id, filled_qty, avg_fill_price, created_at, updated_at, source)
       VALUES (?, 'SIM', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'external')`,
      id,
      entry ? "entry" : "exit",
      order.accountId,
      position?.id ?? null,
      order.symbol,
      order.tradeAction === "BUY" || order.tradeAction === "SELL" ? "equity" : "option",
      order.tradeAction,
      order.quantity,
      order.status === "PARTIAL" ? "PARTIAL" : "ACKNOWLEDGED",
      `external:${order.orderId}`,
      order.orderId,
      // Zero, so the next pass applies the whole fill and an exit's earlier fills reach sold_qty.
      0,
      null,
      order.openedAt,
      ctx.now,
    );
    log(ctx, "info", "reconcile.order_adopted", { intentId: id, orderId: order.orderId });
  }
}

/**
 * Positions the broker holds that we do not know (opened in another terminal, or already there
 * when the client first connected) are adopted as external, so they take a slot and are
 * protected like ours. A symbol with an entry of ours in flight is skipped: that fill is ours and
 * becomes its position when the entry is terminal. Shorts are never adopted.
 */
function adoptPositions(
  ctx: ReconcileContext,
  snapshot: BrokerSnapshot,
  protection: ProtectionSettings,
): void {
  for (const held of snapshot.positions) {
    if (held.quantity <= 0) continue;
    if (held.side === "short") {
      logOnce(ctx, `${held.accountId}:${held.symbol}`, "warn", "reconcile.short_position", {
        symbol: held.symbol,
      });
      continue;
    }
    const known = ctx.sql
      .exec<{ n: number }>(
        `SELECT (SELECT COUNT(*) FROM positions WHERE mode = 'SIM' AND symbol = ? AND status != 'CLOSED')
              + (SELECT COUNT(*) FROM intents WHERE mode = 'SIM' AND kind = 'entry' AND symbol = ?
                  AND position_id IS NULL
                  AND (state IN ('ARMED', 'SENT', 'ACKNOWLEDGED', 'PARTIAL', 'CANCEL_PENDING', 'UNKNOWN')
                       OR filled_qty > 0)) AS n`,
        held.symbol,
        held.symbol,
      )
      .one().n;
    if (known > 0) continue;
    const id = crypto.randomUUID();
    insertPosition(ctx, protection, {
      id,
      accountId: held.accountId,
      symbol: held.symbol,
      pointValue: 1,
      details: snapshot.details.get(held.symbol),
      quantity: held.quantity,
      avgEntryPrice: held.avgPriceMicros,
      source: "external",
      openedOn: sessionDate(new Date(ctx.now)),
    });
    log(ctx, "info", "reconcile.position_adopted", {
      positionId: id,
      symbol: held.symbol,
      quantity: held.quantity,
    });
  }
}

/**
 * Option symbols whose contract data a position created in this pass will store. Read from the
 * broker before the transaction, since the transaction cannot await.
 */
export function symbolsNeedingDetails(
  sql: SqlStorage,
  positions: readonly BrokerPosition[],
): string[] {
  const fromEntries = sql
    .exec<{ symbol: string }>(
      `SELECT DISTINCT symbol FROM intents
        WHERE mode = 'SIM' AND kind = 'entry' AND asset_type = 'option' AND position_id IS NULL
          AND (state IN ('ARMED', 'SENT', 'ACKNOWLEDGED', 'PARTIAL', 'CANCEL_PENDING', 'UNKNOWN')
               OR filled_qty > 0)`,
    )
    .toArray()
    .map((row) => row.symbol);
  const open = new Set(
    sql
      .exec<{ symbol: string }>(
        "SELECT symbol FROM positions WHERE mode = 'SIM' AND status != 'CLOSED'",
      )
      .toArray()
      .map((row) => row.symbol),
  );
  const adoptable = positions
    .filter((held) => held.assetType === "option" && held.side === "long" && !open.has(held.symbol))
    .map((held) => held.symbol);
  return [...new Set([...fromEntries, ...adoptable])];
}

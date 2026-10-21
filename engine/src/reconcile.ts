// Brings the DO's intents and positions in line with what the broker reports.
// docs/order-lifecycle.md#reconciliation. `reconcile` is ONE synchronous transaction over a
// snapshot that was read before it: there is no await between reading and writing the counters,
// the sell ledger or the positions (CLAUDE.md, never-break rule 6). It never calls the broker and
// never places or retries an order; it only records what the broker says.

import { sessionDate } from "#lib/domain/calendar.ts";
import { SCALE_OUT_STEPS } from "#lib/domain/scaleout.ts";
import type { BrokerOrder, BrokerPosition } from "./broker/adapter.ts";
import { writeEvent, type EventLevel } from "./events.ts";

/** What was read from the broker for the client's accounts, before the transaction starts. */
export interface BrokerSnapshot {
  /** Open orders and the ones closed recently. */
  readonly orders: readonly BrokerOrder[];
  /** Closed orders from further back, read only when an intent could not be found in `orders`. */
  readonly historical: readonly BrokerOrder[];
  readonly positions: readonly BrokerPosition[];
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

    for (const intent of pending) {
      const order =
        intent.broker_order_id === null ? undefined : orders.get(intent.broker_order_id);
      if (order !== undefined) applyOrder(ctx, intent, order);
    }

    const created = createPositions(ctx, protection);
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
function createPositions(ctx: ReconcileContext, protection: ProtectionSettings): Set<string> {
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
    readonly quantity: number;
    readonly avgEntryPrice: number;
    readonly source: "app" | "external";
    readonly openedOn: string;
  },
): void {
  // Nothing watches a stop yet, so protection starts as `none`; the stop monitor sets `verified`.
  ctx.sql.exec(
    `INSERT INTO positions
       (id, mode, account_id, symbol, point_value, original_qty, sold_qty, avg_entry_price, stop_pct,
        trailing_unlock_pct, protection_state, status, opened_on, source)
     VALUES (?, 'SIM', ?, ?, ?, ?, 0, ?, ?, ?, 'none', 'OPEN', ?, ?)`,
    position.id,
    position.accountId,
    position.symbol,
    position.pointValue,
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

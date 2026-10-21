// The sync loop's pass: read the broker, reconcile, lift the hold. docs/order-lifecycle.md.
// Everything here only READS from the broker (orders, positions, history, symbol details); it never
// places, cancels or retries an order, whatever the broker answers.

import {
  DEFAULT_STOP_PCT,
  DEFAULT_TRAILING_UNLOCK_PCT,
  ORDER_MATCH_SKEW_MS,
  SYNC_INTERVAL_MS,
} from "#lib/domain/config.ts";
import type { BrokerAdapterShape, BrokerOrder, SymbolDetails } from "./broker/adapter.ts";
import { attempt } from "./broker/attempt.ts";
import type { BrokerError } from "./broker/errors.ts";
import { readConnection, type ConnectionContext } from "./connection.ts";
import {
  reconcile,
  symbolsNeedingDetails,
  type BrokerSnapshot,
  type ProtectionSettings,
} from "./reconcile.ts";
import {
  holdForReconciliation,
  markReconciled,
  reconciliationPending,
  reconciliationTicket,
} from "./refresh.ts";
import { writeEvent, type EventLevel } from "./events.ts";
import { logOnce } from "./reconcile.ts";

export interface SyncContext extends ConnectionContext {
  readonly broker: BrokerAdapterShape;
}

export interface SyncResult {
  /** True when this pass completed and lifted the hold. */
  readonly reconciled: boolean;
  /** When to run again; null when the loop should stop. */
  readonly nextInMs: number | null;
}

const DEGRADED_KEY = "sync_degraded";

function log(
  ctx: ConnectionContext,
  level: EventLevel,
  type: string,
  data?: Record<string, unknown>,
) {
  writeEvent(ctx.sql, ctx.now, { mode: "SIM", level, type, message: type, data });
}

/**
 * Whether anything needs watching: a connection with accounts, and a position, an unfinished
 * intent or a reconciliation still pending. When this is false the alarm loop stops.
 */
export function syncWanted(storage: DurableObjectStorage): boolean {
  const { sql } = storage;
  const connected =
    sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM broker_accounts WHERE mode = 'SIM'").one()
      .n > 0;
  if (!connected) return false;
  if (reconciliationPending(storage)) return true;
  const open = sql
    .exec<{ n: number }>(
      `SELECT (SELECT COUNT(*) FROM positions WHERE mode = 'SIM' AND status != 'CLOSED')
            + (SELECT COUNT(*) FROM intents WHERE mode = 'SIM'
                AND state NOT IN ('FILLED', 'CANCELED', 'REJECTED')) AS n`,
    )
    .one().n;
  return open > 0;
}

type Read<A> =
  { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: BrokerError };

/**
 * One pass. A broker failure is a degraded state (docs/order-lifecycle.md#degraded-states): entries
 * stay blocked and protection `unverified` until a later pass succeeds, exits and cancels are not
 * touched, and nothing is retried here beyond the loop's next tick.
 */
export async function runSync(ctx: SyncContext): Promise<SyncResult> {
  const accounts = ctx.sql
    .exec<{ account_id: string }>("SELECT account_id FROM broker_accounts WHERE mode = 'SIM'")
    .toArray()
    .map((row) => row.account_id);
  if (accounts.length === 0) return { reconciled: false, nextInMs: null };

  // Taken before the reads: a hold that lands while they are out is not ours to lift.
  const ticket = reconciliationTicket(ctx.storage);
  const snapshot = await readSnapshot(ctx, accounts);
  if (!snapshot.ok) return degrade(ctx, snapshot.error);

  const settings = await protectionSettings(ctx);
  const summary = reconcile(
    { sql: ctx.sql, storage: ctx.storage, now: ctx.now },
    snapshot.value,
    settings,
  );

  const reconciled = await markReconciled(
    { storage: ctx.storage, db: ctx.db, userId: ctx.userId },
    ticket,
  );
  if (reconciled) restoreProtection(ctx);
  if (ctx.storage.kv.get(DEGRADED_KEY) !== undefined) {
    ctx.storage.kv.delete(DEGRADED_KEY);
    log(ctx, "info", "sync.recovered");
  }
  if (summary.unknownLeft > 0) {
    // A stuck intent waits for a human: log when the count changes, not on every tick.
    logOnce(
      { sql: ctx.sql, storage: ctx.storage, now: ctx.now },
      String(summary.unknownLeft),
      "warn",
      "sync.unknown_pending",
      { intents: summary.unknownLeft },
    );
  }
  return { reconciled, nextInMs: syncWanted(ctx.storage) ? SYNC_INTERVAL_MS : null };
}

async function readSnapshot(
  ctx: SyncContext,
  accounts: readonly string[],
): Promise<Read<BrokerSnapshot>> {
  const { broker } = ctx;
  // Orders first, then positions: a fill that lands between the two reads is then seen in the
  // positions, never missing from them (a position missing would be read as closed).
  const orders = await attempt(broker.orders(accounts));
  if (!orders.ok) return orders;
  const positions = await attempt(broker.positions(accounts));
  if (!positions.ok) return positions;

  const historical = await readHistory(ctx, accounts, orders.value);
  if (!historical.ok) return historical;

  const details = new Map<string, SymbolDetails>();
  for (const symbol of symbolsNeedingDetails(ctx.sql, positions.value)) {
    const found = await attempt(broker.symbolDetails(symbol));
    if (!found.ok) return found;
    details.set(symbol, found.value);
  }
  return {
    ok: true,
    value: {
      orders: orders.value,
      positions: positions.value,
      historical: historical.value,
      details,
    },
  };
}

/** Closed orders are read only when an intent's order is not among the current ones. */
async function readHistory(
  ctx: SyncContext,
  accounts: readonly string[],
  orders: readonly BrokerOrder[],
): Promise<Read<readonly BrokerOrder[]>> {
  const listed = new Set(orders.map((order) => order.orderId));
  const missing = ctx.sql
    .exec<{ created_at: number; broker_order_id: string | null }>(
      `SELECT created_at, broker_order_id FROM intents
        WHERE mode = 'SIM' AND state NOT IN ('FILLED', 'CANCELED', 'REJECTED')`,
    )
    .toArray()
    .filter((row) => row.broker_order_id === null || !listed.has(row.broker_order_id));
  if (missing.length === 0) return { ok: true, value: [] };
  const since = Math.min(...missing.map((row) => row.created_at)) - ORDER_MATCH_SKEW_MS;
  return attempt(ctx.broker.historicalOrders(accounts, since));
}

async function protectionSettings(ctx: SyncContext): Promise<ProtectionSettings> {
  const row = await ctx.db
    .prepare("SELECT stop_pct, trailing_unlock_pct FROM client_settings WHERE user_id = ?")
    .bind(ctx.userId)
    .first<{ stop_pct: number; trailing_unlock_pct: number }>();
  return {
    stopPct: row?.stop_pct ?? DEFAULT_STOP_PCT,
    trailingUnlockPct: row?.trailing_unlock_pct ?? DEFAULT_TRAILING_UNLOCK_PCT,
  };
}

/**
 * The hold marked every open position `unverified`. Once reconciliation lifted it, a position that
 * no UNKNOWN intent touches goes back to what is true: nothing watches a stop yet (`none`); the
 * stop monitor sets `verified` itself. Does nothing if a new hold landed meanwhile.
 */
function restoreProtection(ctx: SyncContext): void {
  if (reconciliationPending(ctx.storage)) return;
  ctx.sql.exec(
    `UPDATE positions SET protection_state = 'none'
      WHERE status != 'CLOSED' AND protection_state = 'unverified'
        AND id NOT IN (SELECT position_id FROM intents WHERE state = 'UNKNOWN' AND position_id IS NOT NULL)`,
  );
}

const DEGRADED = {
  AuthExpired: { type: "sync.token_expired", level: "warn" },
  RateLimited: { type: "sync.rate_limited", level: "warn" },
  Rejected: { type: "sync.broker_error", level: "error" },
  Timeout: { type: "sync.broker_error", level: "warn" },
  Unknown: { type: "sync.broker_error", level: "warn" },
} as const satisfies Record<BrokerError["_tag"], { type: string; level: EventLevel }>;

async function degrade(ctx: SyncContext, error: BrokerError): Promise<SyncResult> {
  // Entries wait and protection is unverified until a pass succeeds again.
  holdForReconciliation(ctx.storage);
  const { type, level } = DEGRADED[error._tag];
  // One event per change of condition, not one per tick.
  if (ctx.storage.kv.get<string>(DEGRADED_KEY) !== type) {
    ctx.storage.kv.put(DEGRADED_KEY, type);
    log(ctx, level, type, { operation: error.operation, failure: error._tag });
  }
  if (error._tag === "AuthExpired") {
    // A token that cannot be renewed waits for the client to reconnect, which restarts the loop.
    const view = await readConnection(ctx);
    if (view.status === "NOT_CONNECTED") return { reconciled: false, nextInMs: null };
    if (view.health.status === "expired" || view.health.status === "revoked") {
      return { reconciled: false, nextInMs: null };
    }
  }
  const wait = error._tag === "RateLimited" ? (error.retryAfterMs ?? 0) : 0;
  return { reconciled: false, nextInMs: Math.max(SYNC_INTERVAL_MS, wait) };
}

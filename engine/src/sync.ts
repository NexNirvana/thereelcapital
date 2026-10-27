// The sync loop's pass: read the broker, reconcile, lift the hold. docs/order-lifecycle.md.
// Reading and reconciling only READ from the broker (orders, positions, history, symbol details); a
// failed pass never places, cancels or retries anything. After a good pass the protection monitor
// (protection.ts) may send one engine-held stop exit through the normal exit path.

import {
  DEFAULT_STOP_PCT,
  DEFAULT_TRAILING_UNLOCK_PCT,
  ORDER_MATCH_SKEW_MS,
  PROTECTION_SETTINGS_TTL_MS,
  SYNC_INTERVAL_MS,
  SYNC_MIN_INTERVAL_MS,
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
import { monitorProtection } from "./protection.ts";
import { cachedSymbolDetails } from "./symbol-details.ts";
import { logEvent, pruneEvents, type EventLevel } from "./events.ts";
import { logOnce } from "./reconcile.ts";
import { timedD1 } from "./timing.ts";

export interface SyncContext extends ConnectionContext {
  readonly broker: BrokerAdapterShape;
  /**
   * The real wall clock, for the throttle and the settings cache. `now` can be pinned by TEST_NOW
   * (clock.ts) and would then never age them. Defaults to `now`, which is the real clock in
   * production and the one test clock elsewhere.
   */
  readonly wallNow?: () => number;
}

const wallNow = (ctx: SyncContext): number => ctx.wallNow?.() ?? ctx.now;

export interface SyncResult {
  /** True when no reconciliation is pending after this call: a pass completed, or a recent one still stands (throttled). */
  readonly reconciled: boolean;
  /** When to run again; null when the loop should stop. */
  readonly nextInMs: number | null;
}

const DEGRADED_KEY = "sync_degraded";
export const LAST_OK_KEY = "sync_last_ok_at";

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

/** A pass completed within the minimum interval and nothing has asked for a new one since. */
function recentlySynced(ctx: SyncContext): boolean {
  const lastOkAt = ctx.storage.kv.get<number>(LAST_OK_KEY);
  if (lastOkAt === undefined || reconciliationPending(ctx.storage)) return false;
  const age = wallNow(ctx) - lastOkAt;
  return age >= 0 && age < SYNC_MIN_INTERVAL_MS;
}

type Read<A> =
  { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: BrokerError };

/**
 * One pass. A broker failure is a degraded state (docs/order-lifecycle.md#degraded-states): entries
 * stay blocked and protection `unverified` until a later pass succeeds, exits and cancels are not
 * touched, and nothing is retried here beyond the loop's next tick.
 *
 * `throttle` is for requests (a page load or poll): when the last good pass is recent and no
 * reconciliation is pending, the broker is not read again and the current state stands.
 */
export async function runSync(
  ctx: SyncContext,
  options: { readonly throttle?: boolean } = {},
): Promise<SyncResult> {
  const accounts = ctx.sql
    .exec<{ account_id: string }>("SELECT account_id FROM broker_accounts WHERE mode = 'SIM'")
    .toArray()
    .map((row) => row.account_id);
  if (accounts.length === 0) return { reconciled: false, nextInMs: null };
  if (options.throttle === true && recentlySynced(ctx)) {
    return { reconciled: true, nextInMs: syncWanted(ctx.storage) ? SYNC_INTERVAL_MS : null };
  }

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
  // After the hold is lifted: the monitor sets verified or unverified and fires the engine-held stop.
  await monitorProtection(ctx);
  if (ctx.storage.kv.get(DEGRADED_KEY) !== undefined) {
    ctx.storage.kv.delete(DEGRADED_KEY);
    logEvent(ctx, "info", "sync.recovered");
  }
  pruneEvents(ctx.sql, ctx.now, "SIM");
  ctx.storage.kv.put(LAST_OK_KEY, wallNow(ctx));
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
  // The first pass on this adapter also proves the accounts to the SIM guard, in parallel, so the
  // first order after a restart does not pay for it. Errors are dropped: the guard checks again.
  const warming = warmAccountGuard(broker, accounts);
  const orders = await attempt(broker.orders(accounts));
  await warming;
  if (!orders.ok) return orders;
  // Started together once the orders are in; the error precedence stays orders, positions, history.
  const [positions, historical] = await Promise.all([
    attempt(broker.positions(accounts)),
    readHistory(ctx, accounts, orders.value),
  ]);
  if (!positions.ok) return positions;
  if (!historical.ok) return historical;

  const details = new Map<string, SymbolDetails>();
  for (const symbol of symbolsNeedingDetails(ctx.sql, positions.value)) {
    const found = await cachedSymbolDetails(ctx, symbol);
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

const warmed = new WeakSet<BrokerAdapterShape>();

/** Once per adapter; awaited inside the pass (never floating) and its failure changes nothing. */
async function warmAccountGuard(
  broker: BrokerAdapterShape,
  accounts: readonly string[],
): Promise<void> {
  if (warmed.has(broker) || broker.warmAccountGuard === undefined) return;
  warmed.add(broker);
  await attempt(broker.warmAccountGuard(accounts));
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

/** A short-lived read-through copy for the loop; D1 `client_settings` stays the only owner. */
const settingsCache = new WeakMap<
  DurableObjectStorage,
  { readonly readAt: number; readonly settings: ProtectionSettings }
>();

async function protectionSettings(ctx: SyncContext): Promise<ProtectionSettings> {
  const cached = settingsCache.get(ctx.storage);
  if (
    cached !== undefined &&
    wallNow(ctx) - cached.readAt >= 0 &&
    wallNow(ctx) - cached.readAt < PROTECTION_SETTINGS_TTL_MS
  ) {
    return cached.settings;
  }
  const readAt = wallNow(ctx);
  const row = await timedD1(
    "protection_settings",
    ctx.db
      .prepare("SELECT stop_pct, trailing_unlock_pct FROM client_settings WHERE user_id = ?")
      .bind(ctx.userId)
      .first<{ stop_pct: number; trailing_unlock_pct: number }>(),
  );
  const settings = {
    stopPct: row?.stop_pct ?? DEFAULT_STOP_PCT,
    trailingUnlockPct: row?.trailing_unlock_pct ?? DEFAULT_TRAILING_UNLOCK_PCT,
  };
  settingsCache.set(ctx.storage, { readAt, settings });
  return settings;
}

/**
 * The hold marked every open position `unverified`. Once reconciliation lifted it, a position that
 * no UNKNOWN intent touches goes back to what is true: nothing watches it yet (`none`); the
 * protection monitor (protection.ts) sets `verified` or `unverified` right after. Does nothing if a new hold landed meanwhile.
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
    logEvent(ctx, level, type, { operation: error.operation, failure: error._tag });
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

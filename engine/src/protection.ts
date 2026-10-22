// Engine-held stop (decision D36, docs/domain-rules.md §7): on each sync tick the DO compares fresh
// bids with each position's exit level and, at or below it, sells `available` at MARKET through the
// normal exit path. No broker StopMarket exists. `protection_state` is `verified` only while this
// monitor holds a fresh quote and a working token for the position (docs/order-lifecycle.md#degraded-states).

import { STOP_REJECTED_COOLDOWN_MS } from "#lib/domain/config.ts";
import { isRegularSession } from "#lib/domain/calendar.ts";
import { nextTrailing, shouldExit, stopLevel, type TrailingState } from "#lib/domain/stop.ts";
import { attempt } from "./broker/attempt.ts";
import type { Quote } from "./broker/adapter.ts";
import { logEvent } from "./events.ts";
import { stopExit, type ExitContext } from "./exits.ts";
import { committedQty } from "./ledger.ts";
import { reconciliationPending } from "./refresh.ts";

interface WatchedPosition extends Record<string, SqlStorageValue> {
  id: string;
  symbol: string;
  avg_entry_price: number;
  stop_pct: number;
  trailing_pct: number | null;
  trailing_peak: number | null;
  trailing_level: number | null;
  protection_state: string;
  original_qty: number;
  sold_qty: number;
  expiry: string | null;
  has_unknown: number;
}

const QUOTES_DEGRADED_KEY = "protection_quotes_degraded";

/** A bid we may act on: present, live (not delayed) and not halted. Our own receive time makes it fresh. */
export function freshBid(quote: Quote | undefined): number | null {
  if (quote === undefined || quote.bid === null || quote.isDelayed || quote.isHalted) return null;
  // A zero or negative bid is no price: it would read as below any stop level.
  if (!Number.isFinite(quote.bid) || quote.bid <= 0) return null;
  return quote.bid;
}

function setState(ctx: ExitContext, positionId: string, state: "verified" | "unverified"): void {
  ctx.sql.exec(
    "UPDATE positions SET protection_state = ? WHERE id = ? AND status != 'CLOSED' AND protection_state != ?",
    state,
    positionId,
    state,
  );
}

/**
 * docs/domain-rules.md §8: with trailing active, each fresh bid raises the peak and the level (never
 * lowers them) and the new values are stored before anything is sent.
 */
function followTrailing(ctx: ExitContext, row: WatchedPosition, bid: number): TrailingState | null {
  if (row.trailing_pct === null || row.trailing_peak === null || row.trailing_level === null) {
    return null;
  }
  const next = nextTrailing(
    { trailingPct: row.trailing_pct, peak: row.trailing_peak, level: row.trailing_level },
    bid,
  );
  if (next.peak !== row.trailing_peak || next.level !== row.trailing_level) {
    ctx.sql.exec(
      "UPDATE positions SET trailing_peak = ?, trailing_level = ? WHERE id = ?",
      next.peak,
      next.level,
      row.id,
    );
  }
  return next;
}

/**
 * Cheap local checks before the exit path (which asks the broker for symbol details): something is
 * left to sell, the market is open, and the broker did not just reject a stop for this position.
 * The exit path decides again inside its own transaction; this only avoids a call per tick.
 */
function stopCanBeSent(ctx: ExitContext, row: WatchedPosition): boolean {
  if (row.original_qty - row.sold_qty - committedQty(ctx.sql, row.id) <= 0) return false;
  // An option has an expiry; both kinds close at 16:00 ET (D30).
  const kind = row.expiry === null ? "equity" : "option";
  if (!isRegularSession({ kind }, new Date(ctx.now)).open) return false;
  const rejectedAt = ctx.sql
    .exec<{ at: number | null }>(
      "SELECT MAX(updated_at) AS at FROM intents WHERE position_id = ? AND kind IN ('stop', 'trailing') AND state = 'REJECTED'",
      row.id,
    )
    .one().at;
  return rejectedAt === null || ctx.now - rejectedAt >= STOP_REJECTED_COOLDOWN_MS;
}

/**
 * Called after a sync pass that read the broker successfully (so the token works). While a
 * reconciliation hold is pending nothing is verified and nothing is sent: the pass that lifts it
 * runs this next. Reads quotes once, never retries an order.
 */
export async function monitorProtection(ctx: ExitContext): Promise<void> {
  if (reconciliationPending(ctx.storage)) return;
  const watched = ctx.sql
    .exec<WatchedPosition>(
      `SELECT id, symbol, original_qty, sold_qty, expiry, avg_entry_price, stop_pct, trailing_pct, trailing_peak, trailing_level, protection_state,
              EXISTS (SELECT 1 FROM intents WHERE position_id = positions.id AND state = 'UNKNOWN') AS has_unknown
         FROM positions WHERE mode = 'SIM' AND status != 'CLOSED'`,
    )
    .toArray();
  if (watched.length === 0) return;

  const symbols = [...new Set(watched.map((row) => row.symbol))];
  const quotes = await attempt(ctx.broker.quotes(symbols));
  if (!quotes.ok) {
    for (const row of watched) setState(ctx, row.id, "unverified");
    if (ctx.storage.kv.get(QUOTES_DEGRADED_KEY) !== quotes.error._tag) {
      ctx.storage.kv.put(QUOTES_DEGRADED_KEY, quotes.error._tag);
      logEvent(ctx, "warn", "protection.quotes_unavailable", { failure: quotes.error._tag });
    }
    return;
  }
  ctx.storage.kv.delete(QUOTES_DEGRADED_KEY);
  const bySymbol = new Map(quotes.value.map((quote) => [quote.symbol, quote]));

  for (const row of watched) {
    const bid = freshBid(bySymbol.get(row.symbol));
    // An exit with no known outcome makes the position's protection unverified until reconciled.
    if (bid === null || row.has_unknown > 0) {
      setState(ctx, row.id, "unverified");
      continue;
    }
    setState(ctx, row.id, "verified");
    const trailing = followTrailing(ctx, row, bid);
    if (!shouldExit({ avgEntryPrice: row.avg_entry_price, stopPct: row.stop_pct, trailing }, bid)) {
      ctx.storage.kv.delete(`protection_outcome:${row.id}`);
      continue;
    }
    if (!stopCanBeSent(ctx, row)) continue;
    // The trailing level is the effective exit level when it is above the stop (domain-rules.md §8).
    const kind =
      trailing !== null && trailing.level > stopLevel(row.avg_entry_price, row.stop_pct)
        ? "trailing"
        : "stop";
    const result = await stopExit(ctx, row.id, "SIM", kind);
    const outcome = !result.ok
      ? result.code
      : result.value.status === "BLOCKED"
        ? result.value.reasons.join(",")
        : result.value.status === "PLACED"
          ? result.value.state
          : result.value.status;
    // The same blocked outcome (outside the session, a sell already working) repeats every tick:
    // one event per change, not per tick.
    const key = `protection_outcome:${row.id}`;
    if (ctx.storage.kv.get(key) !== outcome) {
      ctx.storage.kv.put(key, outcome);
      logEvent(ctx, "info", `protection.${kind}_triggered`, { positionId: row.id, bid, outcome });
    }
  }
}

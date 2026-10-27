// The Posiciones screen's read (docs/screens-and-flows.md, /posiciones). Reads only: no order is
// placed, cancelled or changed, and nothing returned is a secret, token or broker order id.

import type {
  PendingExitView,
  PositionView,
  PositionsVerification,
  PositionsView,
} from "#lib/domain/positions-view.ts";
import type { ScaleOutStepState } from "#lib/domain/scaleout.ts";
import { MAX_OPEN_POSITIONS } from "#lib/domain/guards.ts";
import { expiryCloseAt, isExpirationDay } from "#lib/domain/expiry.ts";
import { LAST_OK_KEY, readConnection, type ConnectionContext } from "./connection.ts";

type PositionRow = {
  id: string;
  account_id: string;
  symbol: string;
  underlying: string | null;
  expiry: string | null;
  strike: number | null;
  right: string | null;
  original_qty: number;
  sold_qty: number;
  protection_state: string;
  stop_pct: number;
  trailing_unlock_pct: number;
  trailing_pct: number | null;
};
type StepRow = { position_id: string; state: ScaleOutStepState };
type PendingRow = {
  id: string;
  position_id: string;
  kind: string;
  state: string;
  qty: number;
  filled_qty: number;
  has_broker_order: number;
};

/** The rows only; the caller adds `verification`, which needs the connection. */
export function readPositionsView(
  sql: SqlStorage,
  now: number,
): Omit<PositionsView, "verification"> {
  const steps = new Map<string, ScaleOutStepState[]>();
  for (const row of sql
    .exec<StepRow>(
      `SELECT s.position_id, s.state
         FROM scaleout_steps s JOIN positions p ON p.id = s.position_id
        WHERE p.mode = 'SIM' AND p.status != 'CLOSED'
        ORDER BY s.position_id, s.idx`,
    )
    .toArray()) {
    steps.set(row.position_id, [...(steps.get(row.position_id) ?? []), row.state]);
  }
  const positions: PositionView[] = sql
    .exec<PositionRow>(
      `SELECT id, account_id, symbol, underlying, expiry, strike, right, original_qty, sold_qty,
              protection_state, stop_pct, trailing_unlock_pct, trailing_pct
         FROM positions WHERE mode = 'SIM' AND status != 'CLOSED' ORDER BY opened_on, symbol`,
    )
    .toArray()
    .map((row) => ({
      id: row.id,
      accountId: row.account_id,
      symbol: row.symbol,
      option:
        row.underlying !== null &&
        row.expiry !== null &&
        row.strike !== null &&
        (row.right === "call" || row.right === "put")
          ? {
              underlying: row.underlying,
              expiration: row.expiry,
              strikeMicros: row.strike,
              right: row.right,
            }
          : null,
      originalQty: row.original_qty,
      soldQty: row.sold_qty,
      protectionState: row.protection_state,
      stopPct: row.stop_pct,
      trailingUnlockPct: row.trailing_unlock_pct,
      trailingPct: row.trailing_pct,
      expiryCloseAt:
        row.expiry !== null && isExpirationDay(row.expiry, new Date(now))
          ? (expiryCloseAt(row.expiry)?.getTime() ?? null)
          : null,
      steps: steps.get(row.id) ?? [],
    }));
  const pending: PendingExitView[] = sql
    .exec<PendingRow>(
      `SELECT id, position_id, kind, state, qty, filled_qty,
              (broker_order_id IS NOT NULL AND source = 'app') AS has_broker_order
         FROM intents
        WHERE mode = 'SIM' AND position_id IS NOT NULL AND kind != 'entry'
          AND state NOT IN ('FILLED', 'CANCELED', 'REJECTED')
        ORDER BY created_at, id`,
    )
    .toArray()
    .map((row) => ({
      id: row.id,
      positionId: row.position_id,
      kind: row.kind,
      state: row.state,
      qty: row.qty,
      filledQty: row.filled_qty,
      // Mirrors cancelIntent: only our own exits that the broker holds and has not ended.
      cancelable:
        row.kind === "exit" &&
        row.has_broker_order === 1 &&
        (row.state === "ACKNOWLEDGED" || row.state === "PARTIAL"),
    }));
  return { positions, pending, maxPositions: MAX_OPEN_POSITIONS };
}

/**
 * Unverified until a sync pass has confirmed the state: while the connection cannot reach the broker
 * (never connected, expired, revoked, failing), after a failed pass, and in the moments after a
 * connect or disconnect, before the first pass lifts the hold. That is `entriesBlocked`
 * (docs/order-lifecycle.md#degraded-states). `lastSyncAt` is the last good pass. If D1 cannot say
 * what the connection is, the rows are still returned, as unverified.
 */
export async function readVerification(ctx: ConnectionContext): Promise<PositionsVerification> {
  const connection = await readConnection(ctx).catch(() => null);
  if (connection === null) {
    return { status: "unverified", lastSyncAt: ctx.storage.kv.get<number>(LAST_OK_KEY) ?? null };
  }
  if (connection.status === "CONNECTED" && !connection.entriesBlocked) {
    return { status: "verified" };
  }
  return {
    status: "unverified",
    lastSyncAt: connection.status === "CONNECTED" ? connection.lastSyncAt : null,
  };
}

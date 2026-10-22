// The Posiciones screen's read (docs/screens-and-flows.md, /posiciones). Reads only: no order is
// placed, cancelled or changed, and nothing returned is a secret, token or broker order id.

import type { PendingExitView, PositionView, PositionsView } from "#lib/domain/positions-view.ts";
import type { ScaleOutStepState } from "#lib/domain/scaleout.ts";
import { entryLimits } from "./entries.ts";

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

export function readPositionsView(sql: SqlStorage, now: number): PositionsView {
  const steps = new Map<string, ScaleOutStepState[]>();
  for (const row of sql
    .exec<StepRow>(
      `SELECT position_id, state FROM scaleout_steps WHERE mode = 'SIM' ORDER BY position_id, idx`,
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
  return { positions, pending, maxPositions: entryLimits({ sql, now }).maxPositions };
}

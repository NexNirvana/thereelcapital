// The per-position sell ledger and its scale-out steps. docs/order-lifecycle.md rule 4,
// docs/domain-rules.md §6. Every function is synchronous: callers read and write the ledger inside
// one `transactionSync`, with no await between (CLAUDE.md, never-break rule 6).

import type { ScaleOutStepState } from "#lib/domain/scaleout.ts";

/** Exit intents whose unfilled part may still sell: CANCEL_PENDING can still fill, UNKNOWN may exist. */
const COMMITTING_STATES =
  "('ARMED', 'SENT', 'ACKNOWLEDGED', 'PARTIAL', 'CANCEL_PENDING', 'UNKNOWN')";

/**
 * Σ unfilled quantity of the position's sells that may still reach the market. Fills already moved
 * into `sold_qty` by the same transaction that recorded them, so nothing is counted twice.
 */
export function committedQty(sql: SqlStorage, positionId: string): number {
  return sql
    .exec<{ n: number }>(
      `SELECT COALESCE(SUM(MAX(qty - filled_qty, 0)), 0) AS n FROM intents
        WHERE position_id = ? AND kind != 'entry' AND state IN ${COMMITTING_STATES}`,
      positionId,
    )
    .one().n;
}

/** The seven steps in index order. */
export function stepStates(sql: SqlStorage, positionId: string): ScaleOutStepState[] {
  return sql
    .exec<{ state: ScaleOutStepState }>(
      "SELECT state FROM scaleout_steps WHERE position_id = ? ORDER BY idx",
      positionId,
    )
    .toArray()
    .map((row) => row.state);
}

/**
 * A step follows the intent that holds it. Any fill makes it `done` (the sold quantity is real, and
 * the cumulative rounding of later steps already counts its percentage); a rejection or a
 * cancellation with no fill gives it back.
 */
export function settleStep(
  sql: SqlStorage,
  intentId: string,
  state: string,
  filledQty: number,
): void {
  const terminal = state === "FILLED" || state === "CANCELED" || state === "REJECTED";
  if (!terminal) return;
  if (filledQty > 0) {
    sql.exec(
      "UPDATE scaleout_steps SET state = 'done' WHERE intent_id = ? AND state = 'pending'",
      intentId,
    );
  } else {
    sql.exec(
      "UPDATE scaleout_steps SET state = 'available', intent_id = NULL WHERE intent_id = ? AND state = 'pending'",
      intentId,
    );
  }
}

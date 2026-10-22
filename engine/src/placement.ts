// The single-attempt order placement shared by entries and exits (docs/order-lifecycle.md). A fix to
// how a placement outcome is persisted (CLAUDE.md "Never break" rule 5) is made here, once.

import type { BrokerAdapterShape, OrderRequest } from "./broker/adapter.ts";
import { attempt } from "./broker/attempt.ts";
import type { ConnectionContext } from "./connection.ts";
import { logEvent } from "./events.ts";

export type PlacementState = "ACKNOWLEDGED" | "REJECTED" | "UNKNOWN";

/**
 * Moves an intent that never reached the market to REJECTED and, only when that really moved it,
 * runs `giveBack` in the same transaction to free what the intent held (the entry reservation or the
 * exit step). Entirely synchronous: the state change and the give-back see the same state (rule 6).
 */
function releaseIntent(ctx: ConnectionContext, intentId: string, giveBack: () => void): void {
  ctx.storage.transactionSync(() => {
    const moved = ctx.sql.exec(
      "UPDATE intents SET state = 'REJECTED', updated_at = ? WHERE id = ? AND state = 'SENT' AND filled_qty = 0",
      ctx.now,
      intentId,
    );
    if (moved.rowsWritten > 0) giveBack();
  });
}

function settle(
  ctx: ConnectionContext,
  intentId: string,
  state: "ACKNOWLEDGED" | "UNKNOWN",
  orderId: string | null,
): void {
  ctx.sql.exec(
    "UPDATE intents SET state = ?, broker_order_id = ?, updated_at = ? WHERE id = ? AND state = 'SENT'",
    state,
    orderId,
    ctx.now,
    intentId,
  );
}

/**
 * Marks the persisted ARMED intent SENT, calls the broker exactly once and records the outcome.
 * `eventPrefix` names the events (`entry.rejected`, `exit.unknown`) and `giveBack` frees what the
 * intent reserved when the broker answers that it did not take the order.
 *
 * The only await is the broker call. Everything before it (the SENT write) and each outcome after it
 * (`settle`, `releaseIntent`) is synchronous, so no counter or ledger is read and written across an
 * await (rule 6), and the SENT write happens before the request can leave (rule 5).
 */
export async function placeOnce(
  ctx: ConnectionContext,
  broker: Pick<BrokerAdapterShape, "placeOrder">,
  placement: {
    readonly intentId: string;
    readonly request: OrderRequest;
    readonly eventPrefix: "entry" | "exit";
    readonly giveBack: () => void;
  },
): Promise<PlacementState> {
  const { intentId, eventPrefix } = placement;
  ctx.sql.exec(
    "UPDATE intents SET state = 'SENT', updated_at = ? WHERE id = ? AND state = 'ARMED'",
    ctx.now,
    intentId,
  );
  try {
    // Exactly one attempt. No retry here or in the adapter: after a timeout the order may exist.
    const placed = await attempt(broker.placeOrder(placement.request));
    if (placed.ok) {
      settle(ctx, intentId, "ACKNOWLEDGED", placed.value.orderId);
      return "ACKNOWLEDGED";
    }
    if (
      placed.error._tag === "Rejected" ||
      placed.error._tag === "AuthExpired" ||
      placed.error._tag === "RateLimited"
    ) {
      // The broker answered that it did not take the order, so nothing exists to reconcile.
      releaseIntent(ctx, intentId, placement.giveBack);
      logEvent(ctx, "warn", `${eventPrefix}.rejected`, {
        intentId,
        failure: placed.error._tag,
        ...(placed.error._tag === "Rejected"
          ? { code: placed.error.code, reason: placed.error.reason }
          : {}),
      });
      return "REJECTED";
    }
    settle(ctx, intentId, "UNKNOWN", null);
    logEvent(ctx, "warn", `${eventPrefix}.unknown`, { intentId, failure: placed.error._tag });
    return "UNKNOWN";
  } catch {
    // An unexpected failure while the request may have left: same as a timeout.
    settle(ctx, intentId, "UNKNOWN", null);
    logEvent(ctx, "error", `${eventPrefix}.unknown`, { intentId, failure: "defect" });
    return "UNKNOWN";
  }
}

// Exit orders (scale-out steps and ALL OUT) and cancels. docs/order-lifecycle.md,
// docs/domain-rules.md §6. The browser names a position and a step; the quantity is computed here
// from the shared sell ledger, never read from the request (CLAUDE.md, rule 3).
//
// Shape of exitPosition, in the order that keeps the money rules:
//   1. awaits: connection and symbol details (nothing is written)
//   2. ONE synchronous transaction: guards, quantity from the ledger, step -> pending, intent ARMED
//   3. mark SENT, then the single broker call (never retried)
//   4. a synchronous write of the outcome: ACKNOWLEDGED, REJECTED (gives the step back) or UNKNOWN
// Limits never apply here: exits and cancels are not entries (CLAUDE.md, rule 7).

import { isRegularSession, type InstrumentKind } from "#lib/domain/calendar.ts";
import { allOutQty, scaleOutQty } from "#lib/domain/scaleout.ts";
import { checkOrder, type RejectionReason } from "#lib/domain/guards.ts";
import type { ConnectionHealth } from "#lib/domain/connection.ts";
import type { BrokerAdapterShape, OrderRequest } from "./broker/adapter.ts";
import { attempt } from "./broker/attempt.ts";
import { readConnection, type ConnectionContext } from "./connection.ts";
import type { BrokerAccount } from "./tradestation/accounts.ts";
import { logEvent } from "./events.ts";
import { newIntentId } from "./ids.ts";
import { committedQty, settleStep, stepStates } from "./ledger.ts";
import { failure, success, type CancelArgs, type EngineResult, type ExitArgs } from "./rpc.ts";

export interface ExitContext extends ConnectionContext {
  readonly broker: BrokerAdapterShape;
}

export type ExitBlockCode =
  | RejectionReason
  | "NOT_CONNECTED"
  | "CONNECTION_UNUSABLE"
  | "POSITION_NOT_FOUND"
  | "STEP_NOT_AVAILABLE"
  | "NOTHING_AVAILABLE"
  /** An exit of this position has no known outcome yet: reconciliation resolves it first. */
  | "UNKNOWN_INTENT_PENDING";

export type ExitResult =
  | { readonly status: "BLOCKED"; readonly reasons: readonly ExitBlockCode[] }
  /** The step rounds to zero contracts: nothing is sent and the step is used (domain-rules.md §6). */
  | { readonly status: "DONE_ZERO"; readonly step: number }
  | {
      readonly status: "PLACED";
      readonly intentId: string;
      readonly state: string;
      readonly qty: number;
    };

export type CancelBlockCode =
  | "NOT_CONNECTED"
  | "CONNECTION_UNUSABLE"
  | "INTENT_NOT_FOUND"
  | "NOT_CANCELABLE"
  | "OUTSIDE_REGULAR_SESSION"
  | "UNKNOWN_INTENT_PENDING";

export type CancelResult =
  | { readonly status: "BLOCKED"; readonly reasons: readonly CancelBlockCode[] }
  | {
      readonly status: "REQUESTED";
      readonly intentId: string;
      /** CANCEL_PENDING, or the earlier state when the broker did not take the request (token, rate limit). */
      readonly state: string;
      /** True when the cancel was already requested: the broker was not called again. */
      readonly replay: boolean;
    };

/**
 * Only a lost grant blocks an exit: it cannot reach the broker at all. A transient `error` is still
 * tried (a stuck position matters more than a failed call), and a reconciliation hold never blocks.
 */
function unusable(health: ConnectionHealth): boolean {
  return health.status === "expired" || health.status === "revoked";
}

interface PositionRow extends Record<string, SqlStorageValue> {
  id: string;
  account_id: string;
  symbol: string;
  original_qty: number;
  sold_qty: number;
  status: string;
}

function readPosition(ctx: ConnectionContext, positionId: string): PositionRow | undefined {
  return ctx.sql
    .exec<PositionRow>(
      `SELECT id, account_id, symbol, original_qty, sold_qty, status FROM positions
        WHERE id = ? AND mode = 'SIM' AND status != 'CLOSED'`,
      positionId,
    )
    .toArray()[0];
}

type Reservation =
  | { readonly kind: "blocked"; readonly reasons: readonly ExitBlockCode[] }
  | { readonly kind: "done_zero"; readonly step: number }
  | { readonly kind: "armed"; readonly qty: number; readonly request: OrderRequest };

interface Instrument {
  readonly assetType: "equity" | "option";
  readonly increment: number;
}

/**
 * One synchronous transaction, no await inside: the guards, the quantity and the writes see the same
 * ledger (order-lifecycle.md, rule 3). Everything an await could have changed is read again here.
 */
function reserve(
  ctx: ExitContext,
  args: ExitArgs,
  intentId: string,
  account: BrokerAccount,
  instrument: Instrument,
  kind: ExitKind,
): Reservation {
  return ctx.storage.transactionSync((): Reservation => {
    const position = readPosition(ctx, args.positionId);
    if (position === undefined) return { kind: "blocked", reasons: ["POSITION_NOT_FOUND"] };
    const unresolved = ctx.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM intents
          WHERE position_id = ? AND kind != 'entry' AND state = 'UNKNOWN'`,
        position.id,
      )
      .one().n;
    if (unresolved > 0) return { kind: "blocked", reasons: ["UNKNOWN_INTENT_PENDING"] };

    const quantities = {
      originalQty: position.original_qty,
      soldQty: position.sold_qty,
      committedQty: committedQty(ctx.sql, position.id),
    };
    let qty: number;
    if (args.step === "ALL_OUT") {
      qty = allOutQty(quantities);
      if (qty === 0) return { kind: "blocked", reasons: ["NOTHING_AVAILABLE"] };
    } else {
      const outcome = scaleOutQty(
        quantities,
        stepStates(ctx.sql, position.id),
        args.step,
        instrument.increment,
      );
      if (outcome.kind === "rejected") return { kind: "blocked", reasons: ["STEP_NOT_AVAILABLE"] };
      if (outcome.kind === "done_zero") {
        // Zero because open sells already cover the target is not the step's own rounding: the step
        // must stay available in case those sells are rejected or canceled.
        const states = stepStates(ctx.sql, position.id);
        const alone = scaleOutQty(
          { ...quantities, committedQty: 0 },
          states,
          args.step,
          instrument.increment,
        );
        if (alone.kind === "sell") return { kind: "blocked", reasons: ["NOTHING_AVAILABLE"] };
        ctx.sql.exec(
          "UPDATE scaleout_steps SET state = 'done_zero' WHERE position_id = ? AND idx = ? AND state = 'available'",
          position.id,
          args.step,
        );
        return { kind: "done_zero", step: args.step };
      }
      qty = outcome.qty;
    }

    const tradeAction = instrument.assetType === "equity" ? "SELL" : "SELLTOCLOSE";
    const guard = checkOrder(
      {
        mode: "SIM",
        accountId: position.account_id,
        instrument:
          instrument.assetType === "equity"
            ? { kind: "equity", symbol: position.symbol }
            : { kind: "option", symbol: position.symbol, legs: 1 },
        orderType: "Market",
        tradeAction,
        quantity: qty,
      },
      {
        clientId: ctx.userId,
        account: {
          id: account.accountId,
          clientId: ctx.userId,
          type: account.accountType,
          active: true,
        },
        available: quantities.originalQty - quantities.soldQty - quantities.committedQty,
        openSymbols: [],
        now: new Date(ctx.now),
      },
    );
    if (!guard.ok) return { kind: "blocked", reasons: [guard.reason] };

    ctx.sql.exec(
      `INSERT INTO intents
         (id, mode, kind, account_id, position_id, symbol, asset_type, trade_action, qty, state,
          order_confirm_id, created_at, updated_at)
       VALUES (?, 'SIM', ?, ?, ?, ?, ?, ?, ?, 'ARMED', ?, ?, ?)`,
      intentId,
      kind,
      position.account_id,
      position.id,
      position.symbol,
      instrument.assetType,
      tradeAction,
      qty,
      intentId,
      ctx.now,
      ctx.now,
    );
    if (args.step !== "ALL_OUT") {
      ctx.sql.exec(
        "UPDATE scaleout_steps SET state = 'pending', intent_id = ? WHERE position_id = ? AND idx = ? AND state = 'available'",
        intentId,
        position.id,
        args.step,
      );
    }
    return {
      kind: "armed",
      qty,
      request: {
        accountId: position.account_id,
        symbol: position.symbol,
        assetType: instrument.assetType,
        tradeAction,
        quantity: qty,
        orderConfirmId: intentId,
      },
    };
  });
}

/** The broker answered that it did not take the order: nothing exists, so the step is given back. */
function release(ctx: ConnectionContext, intentId: string): void {
  ctx.storage.transactionSync(() => {
    const moved = ctx.sql.exec(
      "UPDATE intents SET state = 'REJECTED', updated_at = ? WHERE id = ? AND state = 'SENT' AND filled_qty = 0",
      ctx.now,
      intentId,
    );
    if (moved.rowsWritten > 0) settleStep(ctx.sql, intentId, "REJECTED", 0);
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

/** A client's own exit, or the engine's stop (docs/domain-rules.md §7); both use this one path. */
export type ExitKind = "exit" | "stop" | "trailing";

export function exitPosition(ctx: ExitContext, args: ExitArgs): Promise<EngineResult<ExitResult>> {
  return placeExit(ctx, args, "exit");
}

/**
 * The engine-held stop or trailing exit (D36): ALL OUT of `available` through the same ledger,
 * intent-first and single-attempt path. It is an exit, not an entry: no counter moves and no limit
 * applies. `kind` records which level fired.
 */
export function stopExit(
  ctx: ExitContext,
  positionId: string,
  mode: ExitArgs["mode"],
  kind: "stop" | "trailing",
): Promise<EngineResult<ExitResult>> {
  return placeExit(ctx, { mode, positionId, step: "ALL_OUT" }, kind);
}

async function placeExit(
  ctx: ExitContext,
  args: ExitArgs,
  kind: ExitKind,
): Promise<EngineResult<ExitResult>> {
  const blocked = (...reasons: ExitBlockCode[]) =>
    success<ExitResult>({ status: "BLOCKED", reasons });

  const view = await readConnection(ctx);
  if (view.status === "NOT_CONNECTED") return blocked("NOT_CONNECTED");
  if (unusable(view.health)) return blocked("CONNECTION_UNUSABLE");
  const position = readPosition(ctx, args.positionId);
  if (position === undefined) return blocked("POSITION_NOT_FOUND");
  const account = view.accounts.find((candidate) => candidate.accountId === position.account_id);
  if (account === undefined) return blocked("ACCOUNT_NOT_OWNED");

  const details = await attempt(ctx.broker.symbolDetails(position.symbol));
  if (!details.ok) {
    logEvent(ctx, "warn", "exit.details_failed", { failure: details.error._tag });
    return failure("BROKER_UNAVAILABLE");
  }
  const instrument: Instrument = {
    assetType: details.value.assetType,
    increment: details.value.quantityIncrement,
  };

  const intentId = newIntentId();
  const reservation = reserve(ctx, args, intentId, account, instrument, kind);
  if (reservation.kind === "blocked") return blocked(...reservation.reasons);
  if (reservation.kind === "done_zero") {
    logEvent(ctx, "info", "exit.step_done_zero", {
      positionId: args.positionId,
      step: reservation.step,
    });
    return success({ status: "DONE_ZERO", step: reservation.step });
  }

  // Persisted above; from here the request is out of our hands, so SENT is written first.
  ctx.sql.exec(
    "UPDATE intents SET state = 'SENT', updated_at = ? WHERE id = ? AND state = 'ARMED'",
    ctx.now,
    intentId,
  );
  let state: string;
  try {
    // Exactly one attempt. No retry here or in the adapter: after a timeout the order may exist.
    const placed = await attempt(ctx.broker.placeOrder(reservation.request));
    if (placed.ok) {
      settle(ctx, intentId, "ACKNOWLEDGED", placed.value.orderId);
      state = "ACKNOWLEDGED";
    } else if (
      placed.error._tag === "Rejected" ||
      placed.error._tag === "AuthExpired" ||
      placed.error._tag === "RateLimited"
    ) {
      release(ctx, intentId);
      logEvent(ctx, "warn", "exit.rejected", {
        intentId,
        failure: placed.error._tag,
        ...(placed.error._tag === "Rejected"
          ? { code: placed.error.code, reason: placed.error.reason }
          : {}),
      });
      state = "REJECTED";
    } else {
      settle(ctx, intentId, "UNKNOWN", null);
      logEvent(ctx, "warn", "exit.unknown", { intentId, failure: placed.error._tag });
      state = "UNKNOWN";
    }
  } catch {
    // An unexpected failure while the request may have left: same as a timeout.
    settle(ctx, intentId, "UNKNOWN", null);
    logEvent(ctx, "error", "exit.unknown", { intentId, failure: "defect" });
    state = "UNKNOWN";
  }
  return success({ status: "PLACED", intentId, state, qty: reservation.qty });
}

interface CancelTarget extends Record<string, SqlStorageValue> {
  account_id: string;
  position_id: string | null;
  asset_type: InstrumentKind;
  state: string;
  broker_order_id: string | null;
}

function readTarget(ctx: ConnectionContext, intentId: string): CancelTarget | undefined {
  return ctx.sql
    .exec<CancelTarget>(
      `SELECT account_id, position_id, asset_type, state, broker_order_id FROM intents
        WHERE id = ? AND mode = 'SIM' AND source = 'app' AND kind IN ('entry', 'exit')`,
      intentId,
    )
    .toArray()[0];
}

/**
 * The only states with an order to cancel: it has a broker id and is open. The intent moves to
 * CANCEL_PENDING before the request leaves and only a broker status ends it (a MARKET order may
 * fill first, and then the intent is FILLED). Entries are cancelable too; their reservations are
 * released by reconciliation when the broker confirms.
 */
export async function cancelIntent(
  ctx: ExitContext,
  args: CancelArgs,
): Promise<EngineResult<CancelResult>> {
  const blocked = (...reasons: CancelBlockCode[]) =>
    success<CancelResult>({ status: "BLOCKED", reasons });

  const view = await readConnection(ctx);
  if (view.status === "NOT_CONNECTED") return blocked("NOT_CONNECTED");
  if (unusable(view.health)) return blocked("CONNECTION_UNUSABLE");

  const prepared = ctx.storage.transactionSync(() => {
    const target = readTarget(ctx, args.intentId);
    if (target === undefined) return { kind: "blocked", reason: "INTENT_NOT_FOUND" } as const;
    if (target.state === "CANCEL_PENDING") return { kind: "replay" } as const;
    if (
      (target.state !== "ACKNOWLEDGED" && target.state !== "PARTIAL") ||
      target.broker_order_id === null
    ) {
      return { kind: "blocked", reason: "NOT_CANCELABLE" } as const;
    }
    // Same rules as an exit (order-lifecycle.md#degraded-states): orders only in session, and not
    // while another order of the position has an unknown outcome.
    if (!isRegularSession({ kind: target.asset_type }, new Date(ctx.now)).open) {
      return { kind: "blocked", reason: "OUTSIDE_REGULAR_SESSION" } as const;
    }
    if (
      target.position_id !== null &&
      ctx.sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM intents
            WHERE position_id = ? AND kind != 'entry' AND state = 'UNKNOWN'`,
          target.position_id,
        )
        .one().n > 0
    ) {
      return { kind: "blocked", reason: "UNKNOWN_INTENT_PENDING" } as const;
    }
    ctx.sql.exec(
      "UPDATE intents SET state = 'CANCEL_PENDING', updated_at = ? WHERE id = ? AND state IN ('ACKNOWLEDGED', 'PARTIAL')",
      ctx.now,
      args.intentId,
    );
    return { kind: "go", accountId: target.account_id, orderId: target.broker_order_id } as const;
  });
  if (prepared.kind === "blocked") return blocked(prepared.reason);
  if (prepared.kind === "replay") {
    return success({
      status: "REQUESTED",
      intentId: args.intentId,
      state: "CANCEL_PENDING",
      replay: true,
    });
  }

  try {
    // Exactly one attempt. Success means "cancel request sent", never CANCELED: only the broker's
    // order status ends CANCEL_PENDING, at the next reconciliation.
    const sent = await attempt(ctx.broker.cancelOrder(prepared.accountId, prepared.orderId));
    if (!sent.ok) {
      const tag = sent.error._tag;
      if (tag === "AuthExpired" || tag === "RateLimited") {
        // The broker did not take the request, so the order is as it was.
        ctx.sql.exec(
          `UPDATE intents SET state = CASE WHEN filled_qty > 0 THEN 'PARTIAL' ELSE 'ACKNOWLEDGED' END,
                 updated_at = ?
            WHERE id = ? AND state = 'CANCEL_PENDING'`,
          ctx.now,
          args.intentId,
        );
      }
      logEvent(ctx, "warn", "cancel.failed", {
        intentId: args.intentId,
        failure: tag,
        ...(sent.error._tag === "Rejected" ? { code: sent.error.code } : {}),
      });
    }
  } catch {
    logEvent(ctx, "error", "cancel.failed", { intentId: args.intentId, failure: "defect" });
  }
  const state =
    ctx.sql
      .exec<{ state: string }>("SELECT state FROM intents WHERE id = ?", args.intentId)
      .toArray()[0]?.state ?? "CANCEL_PENDING";
  return success({ status: "REQUESTED", intentId: args.intentId, state, replay: false });
}

// Manual trailing activation (docs/domain-rules.md §8). The browser names a position and one of the
// allowed percentages; eligibility, the peak (a fresh bid read here) and the level are the engine's.
// After activation the protection monitor (protection.ts) raises the peak and level on each tick.

import { activateTrailing as startTrailing, trailingEligible } from "#lib/domain/stop.ts";
import { attempt } from "./broker/attempt.ts";
import { readConnection } from "./connection.ts";
import type { ExitContext } from "./exits.ts";
import { writeEvent } from "./events.ts";
import { committedQty } from "./ledger.ts";
import { freshBid } from "./protection.ts";
import { success, type ActivateTrailingArgs, type EngineResult } from "./rpc.ts";

export type TrailingBlockCode =
  | "NOT_CONNECTED"
  | "CONNECTION_UNUSABLE"
  | "POSITION_NOT_FOUND"
  | "ALREADY_ACTIVE"
  /** Confirmed sales have not reached the position's unlock %. */
  | "NOT_ELIGIBLE"
  /** A sell of the position has not ended (or has an unknown outcome): reconciliation resolves it first. */
  | "EXIT_PENDING"
  /** No live bid to start the peak from. */
  | "QUOTE_UNAVAILABLE";

export type TrailingResult =
  | { readonly status: "BLOCKED"; readonly reasons: readonly TrailingBlockCode[] }
  | {
      readonly status: "ACTIVATED";
      readonly trailingPct: number;
      readonly peak: number;
      readonly level: number;
    };

interface PositionRow extends Record<string, SqlStorageValue> {
  symbol: string;
  original_qty: number;
  sold_qty: number;
  trailing_unlock_pct: number;
  trailing_pct: number | null;
}

function readPosition(ctx: ExitContext, positionId: string): PositionRow | undefined {
  return ctx.sql
    .exec<PositionRow>(
      `SELECT symbol, original_qty, sold_qty, trailing_unlock_pct, trailing_pct FROM positions
        WHERE id = ? AND mode = 'SIM' AND status != 'CLOSED'`,
      positionId,
    )
    .toArray()[0];
}

export async function activateTrailing(
  ctx: ExitContext,
  args: ActivateTrailingArgs,
): Promise<EngineResult<TrailingResult>> {
  const blocked = (...reasons: TrailingBlockCode[]) =>
    success<TrailingResult>({ status: "BLOCKED", reasons });

  const view = await readConnection(ctx);
  if (view.status === "NOT_CONNECTED") return blocked("NOT_CONNECTED");
  if (view.health.status === "expired" || view.health.status === "revoked") {
    return blocked("CONNECTION_UNUSABLE");
  }
  const found = readPosition(ctx, args.positionId);
  if (found === undefined) return blocked("POSITION_NOT_FOUND");

  const quotes = await attempt(ctx.broker.quotes([found.symbol]));
  const bid = quotes.ok
    ? freshBid(quotes.value.find((quote) => quote.symbol === found.symbol))
    : null;
  if (bid === null) return blocked("QUOTE_UNAVAILABLE");

  // Everything the await could have changed is read again, in one synchronous transaction.
  const outcome = ctx.storage.transactionSync((): TrailingResult => {
    const position = readPosition(ctx, args.positionId);
    if (position === undefined) return { status: "BLOCKED", reasons: ["POSITION_NOT_FOUND"] };
    if (position.trailing_pct !== null) return { status: "BLOCKED", reasons: ["ALREADY_ACTIVE"] };
    if (
      !trailingEligible({
        originalQty: position.original_qty,
        soldQty: position.sold_qty,
        trailingUnlockPct: position.trailing_unlock_pct,
      })
    ) {
      return { status: "BLOCKED", reasons: ["NOT_ELIGIBLE"] };
    }
    if (committedQty(ctx.sql, args.positionId) > 0) {
      return { status: "BLOCKED", reasons: ["EXIT_PENDING"] };
    }
    const state = startTrailing(args.trailingPct, bid);
    ctx.sql.exec(
      "UPDATE positions SET trailing_pct = ?, trailing_peak = ?, trailing_level = ? WHERE id = ?",
      state.trailingPct,
      state.peak,
      state.level,
      args.positionId,
    );
    return { status: "ACTIVATED", ...state };
  });
  if (outcome.status === "ACTIVATED") {
    writeEvent(ctx.sql, ctx.now, {
      mode: "SIM",
      level: "info",
      type: "protection.trailing_activated",
      message: "protection.trailing_activated",
      data: { positionId: args.positionId, trailingPct: outcome.trailingPct },
    });
  }
  return success(outcome);
}

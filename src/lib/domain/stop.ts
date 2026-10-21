import { STOP_PCT_BOUNDS, TRAILING_PCT_OPTIONS, TRAILING_UNLOCK_PCT_BOUNDS } from "./config";
import { assertMicros } from "./money";
import type { PositionQuantities } from "./position";

export type PctRejection =
  "STOP_PCT_OUT_OF_BOUNDS" | "TRAILING_UNLOCK_PCT_OUT_OF_BOUNDS" | "TRAILING_PCT_NOT_ALLOWED";

export type PctResult = { ok: true } | { ok: false; reason: PctRejection };

function inBounds(value: number, bounds: { min: number; max: number }): boolean {
  return Number.isInteger(value) && value >= bounds.min && value <= bounds.max;
}

function isTrailingPct(value: number): boolean {
  return TRAILING_PCT_OPTIONS.some((option) => option === value);
}

/** docs/domain-rules.md §8: the server rejects values outside the decided bounds. */
export function validateStopPct(stopPct: number): PctResult {
  return inBounds(stopPct, STOP_PCT_BOUNDS)
    ? { ok: true }
    : { ok: false, reason: "STOP_PCT_OUT_OF_BOUNDS" };
}

export function validateTrailingUnlockPct(unlockPct: number): PctResult {
  return inBounds(unlockPct, TRAILING_UNLOCK_PCT_BOUNDS)
    ? { ok: true }
    : { ok: false, reason: "TRAILING_UNLOCK_PCT_OUT_OF_BOUNDS" };
}

export function validateTrailingPct(trailingPct: number): PctResult {
  return isTrailingPct(trailingPct)
    ? { ok: true }
    : { ok: false, reason: "TRAILING_PCT_NOT_ALLOWED" };
}

/** Write time: the activation path rejects what the current rules do not allow. */
function assertValid(result: PctResult): void {
  if (!result.ok) throw new RangeError(result.reason);
}

/**
 * Read time: a stored percentage was valid when it was written and is trusted even if the bounds
 * have changed since (the position keeps the value it opened with). This only guards the arithmetic,
 * so a corrupted row fails loudly instead of producing a nonsense level.
 */
function assertStoredPct(pct: number): void {
  if (!Number.isInteger(pct) || pct < 1 || pct > 99) {
    throw new RangeError("A stored percentage must be a whole number from 1 to 99");
  }
}

/** price × (100 − pct) / 100 in micro-dollars, rounded down; exact in BigInt. */
function belowPrice(price: number, pct: number): number {
  return Number((BigInt(price) * BigInt(100 - pct)) / 100n);
}

/** docs/domain-rules.md §7. Prices are micro-dollars; `stopPct` is the value stored on the position. */
export function stopLevel(avgEntryPrice: number, stopPct: number): number {
  assertMicros(avgEntryPrice);
  assertStoredPct(stopPct);
  return belowPrice(avgEntryPrice, stopPct);
}

export interface TrailingEligibilityInput extends Pick<
  PositionQuantities,
  "originalQty" | "soldQty"
> {
  /** The unlock % stored on the position at open, not the client's current setting. */
  trailingUnlockPct: number;
}

/** docs/domain-rules.md §8. Only confirmed `soldQty` counts: not pending or done_zero steps. */
export function trailingEligible(position: TrailingEligibilityInput): boolean {
  const { originalQty, soldQty, trailingUnlockPct } = position;
  assertStoredPct(trailingUnlockPct);
  return (
    originalQty > soldQty &&
    BigInt(soldQty) * 100n >= BigInt(trailingUnlockPct) * BigInt(originalQty)
  );
}

export interface TrailingState {
  trailingPct: number;
  peak: number;
  /** Never decreases. */
  level: number;
}

/** Manual activation: the peak starts at the fresh bid. */
export function activateTrailing(trailingPct: number, bid: number): TrailingState {
  assertValid(validateTrailingPct(trailingPct));
  return nextTrailing({ trailingPct, peak: 0, level: 0 }, bid);
}

/** docs/domain-rules.md §8. Call with each fresh bid; returns a new state. */
export function nextTrailing(state: TrailingState, bid: number): TrailingState {
  assertStoredPct(state.trailingPct);
  assertMicros(state.peak);
  assertMicros(state.level);
  assertMicros(bid);
  const peak = Math.max(state.peak, bid);
  const level = Math.max(state.level, belowPrice(peak, state.trailingPct));
  return { trailingPct: state.trailingPct, peak, level };
}

export interface ExitPosition {
  avgEntryPrice: number;
  stopPct: number;
  /** Null until trailing is activated. */
  trailing: TrailingState | null;
}

/** docs/domain-rules.md §7 and §8: exit when the fresh bid is at or below max(stopLevel, trailLevel). */
export function shouldExit(position: ExitPosition, bid: number): boolean {
  assertMicros(bid);
  const stop = stopLevel(position.avgEntryPrice, position.stopPct);
  return bid <= Math.max(stop, position.trailing?.level ?? 0);
}

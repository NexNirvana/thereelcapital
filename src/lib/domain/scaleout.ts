import { availableQty, type PositionQuantities } from "./position";

export const SCALE_OUT_STEPS: readonly [30, 20, 10, 10, 10, 10, 10] = [30, 20, 10, 10, 10, 10, 10];

export type ScaleOutStepState = "available" | "pending" | "done" | "done_zero";

export type ScaleOutResult =
  | { kind: "sell"; qty: number }
  | { kind: "done_zero" }
  | { kind: "rejected"; reason: "STEP_INDEX_OUT_OF_RANGE" | "STEP_NOT_AVAILABLE" };

/** docs/domain-rules.md §6. Increment is 1 for contracts, broker-supplied for equities. */
export function scaleOutQty(
  position: PositionQuantities,
  steps: readonly ScaleOutStepState[],
  stepIndex: number,
  increment = 1,
): ScaleOutResult {
  if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= SCALE_OUT_STEPS.length) {
    return { kind: "rejected", reason: "STEP_INDEX_OUT_OF_RANGE" };
  }
  if (steps[stepIndex] !== "available") {
    return { kind: "rejected", reason: "STEP_NOT_AVAILABLE" };
  }
  if (!Number.isSafeInteger(increment) || increment <= 0) {
    throw new RangeError("Increment must be a positive safe integer");
  }

  const cumPct = SCALE_OUT_STEPS.reduce((total, pct, index) => {
    const state = steps[index];
    return index === stepIndex || state === "pending" || state === "done" || state === "done_zero"
      ? total + pct
      : total;
  }, 0);
  const unit = BigInt(increment);
  const target = Number(
    ((BigInt(position.originalQty) * BigInt(cumPct) + 50n * unit) / (100n * unit)) * unit,
  );
  const remaining = Math.min(
    availableQty(position),
    Math.max(0, target - position.soldQty - position.committedQty),
  );
  // Partial fills can leave a remainder that is not a multiple of the increment.
  const qty = Math.floor(remaining / increment) * increment;
  return qty === 0 ? { kind: "done_zero" } : { kind: "sell", qty };
}

export function allOutQty(position: PositionQuantities): number {
  return availableQty(position);
}

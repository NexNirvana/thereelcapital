/** Nonnegative safe-integer quantities; sold counts only confirmed exit fills. */
export type PositionQuantities = {
  originalQty: number;
  soldQty: number;
  committedQty: number;
};

export function availableQty(position: PositionQuantities): number {
  return Math.max(0, position.originalQty - position.soldQty - position.committedQty);
}

// What the Posiciones screen reads from the engine: the client's open positions with their seven
// steps, and the exit orders still working. Plain data; it carries no price, P&L, broker order id
// or secret, and the browser never sends any of it back (it names a position id and a step).

import type { ScaleOutStepState } from "./scaleout";

export interface PositionView {
  readonly id: string;
  readonly accountId: string;
  /** The tradable symbol: the ticker, or the OCC-style option symbol. */
  readonly symbol: string;
  /** Present for options only. */
  readonly option: {
    readonly underlying: string;
    /** YYYY-MM-DD */
    readonly expiration: string;
    /** Micro-dollars, like every price. */
    readonly strikeMicros: number;
    readonly right: "call" | "put";
  } | null;
  readonly originalQty: number;
  readonly soldQty: number;
  /** Stored as the engine wrote it. Only `verified` means the stop is watching. */
  readonly protectionState: string;
  readonly stopPct: number;
  readonly trailingUnlockPct: number;
  readonly trailingPct: number | null;
  readonly steps: readonly ScaleOutStepState[];
}

/** An order of a position that has not reached a final state. */
export interface PendingExitView {
  readonly id: string;
  readonly positionId: string;
  readonly kind: string;
  readonly state: string;
  readonly qty: number;
  readonly filledQty: number;
  /** The engine would take a cancel now (it has a broker order and is open). */
  readonly cancelable: boolean;
}

export interface PositionsView {
  readonly positions: readonly PositionView[];
  readonly pending: readonly PendingExitView[];
  readonly maxPositions: number;
}

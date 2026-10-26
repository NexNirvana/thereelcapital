// What the server hands the Opciones tab about a chain (src/lib/server/chain-view.ts): types only.

export interface ChainSide {
  readonly symbol: string;
  readonly bid: number;
  readonly ask: number;
}

export interface ChainView {
  readonly underlying: string;
  /** The ISO date of the chain on screen, or "" when none was chosen. */
  readonly expiration: string;
  /** What the Vencimiento field shows, and the clock its labels count from. */
  readonly expirationText: string;
  readonly nowMs: number;
  /** Why no expiration was chosen: a lead and the listed dates to pick from. */
  readonly choice: { lead: string; dates: ReadonlyArray<string> } | null;
  readonly notice: string | null;
  readonly expirations: ReadonlyArray<string> | null;
  readonly chain: {
    readonly receivedAt: number;
    /** TradeStation's quote of the underlying in micro-dollars, or null when it was not read. */
    readonly underlyingPrice: number | null;
    readonly strikes: ReadonlyArray<{
      readonly strike: number;
      readonly call: ChainSide | null;
      readonly put: ChainSide | null;
    }>;
  } | null;
  readonly problem: string | null;
}

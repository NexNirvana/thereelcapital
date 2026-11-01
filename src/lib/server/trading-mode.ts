import type { GuardEvent } from "./guards.ts";

export type TradingMode = "SIM" | "REAL";

/**
 * The trading mode every engine call of a request is made in. SIM only until REAL mode is built
 * behind its locks (D52): the later UI issue makes this read the client's chosen mode, so the
 * routes already ask for it per request.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the request will choose the mode (D52)
export function modeFor(_event: GuardEvent): TradingMode {
  return "SIM";
}

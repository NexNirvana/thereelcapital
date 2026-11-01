// Which trading modes a client may use right now (docs/domain-rules.md#11-trading-modes-d52, D52).
// SIM is always open. REAL needs the deployment switch (lock 1) and, for entries, the client's
// switch (lock 2). The account lock (3) and the transport lock (4) are checked per order, not here.

export type Mode = "SIM" | "REAL";

export interface ModeLocks {
  /** The engine's `REAL_TRADING` variable is exactly "enabled" (lock 1). */
  readonly deploymentOpen: boolean;
  /** `client_settings.real_trading_enabled` (lock 2). */
  readonly clientEnabled: boolean;
  /** The client still has an open REAL position or an unfinished REAL intent. */
  readonly hasOpenReal: boolean;
}

export interface AllowedModes {
  readonly entries: readonly Mode[];
  readonly exits: readonly Mode[];
}

/**
 * Turning the client switch off blocks new REAL entries but never exits or protections of what is
 * already open, so REAL stays in `exits` while the deployment is open and the client either has
 * the switch on or still has something open in REAL.
 */
export function allowedModes({
  deploymentOpen,
  clientEnabled,
  hasOpenReal,
}: ModeLocks): AllowedModes {
  return {
    entries: deploymentOpen && clientEnabled ? ["SIM", "REAL"] : ["SIM"],
    exits: deploymentOpen && (clientEnabled || hasOpenReal) ? ["SIM", "REAL"] : ["SIM"],
  };
}

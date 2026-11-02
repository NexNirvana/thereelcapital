// The effective REAL state of one client for the admin (docs/screens-and-flows.md#admin, D52):
// the client switch (lock 2, from D1) read together with what the engine allows right now.
import type { AllowedModes } from "./modes.ts";

export type RealState =
  /** The switch is on and the deployment lets REAL entries through. */
  | "active"
  /** The switch is off but REAL positions are open: only exits and protections are allowed. */
  | "exits-only"
  /** The switch is on but the deployment is closed: no REAL order can leave. */
  | "closed"
  /**
   * The switch is off and nothing REAL is open, or the deployment is closed with the switch off:
   * the engine answers the same SIM-only modes for both, so they cannot be told apart here.
   */
  | "off";

/**
 * Derived only from what the engine answered, never from the deployment switch itself: REAL in
 * `entries` means open and enabled; REAL only in `exits` means the client switch is off with
 * something open; neither with the switch on can only be a closed deployment.
 */
export function realStateOf(enabled: boolean, modes: AllowedModes): RealState {
  if (modes.entries.includes("REAL")) return "active";
  if (modes.exits.includes("REAL")) return "exits-only";
  return enabled ? "closed" : "off";
}

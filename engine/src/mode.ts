import { Schema } from "effect";

/** REAL is decoded so it can be rejected by name; it is never served (CLAUDE.md, SIM only). */
export const Mode = Schema.Literals(["SIM", "REAL"]);
export type Mode = typeof Mode.Type;

/**
 * The modes the background passes (sync, reconcile, protection, trailing) serve. SIM only until
 * REAL mode is built behind its locks (D52, docs/open-questions.md): this is the one place the REAL
 * issues widen, and RPC and the order guard keep rejecting REAL until then.
 */
export function activeModes(): readonly [Mode, ...Mode[]] {
  return ["SIM"];
}

/**
 * The first lock of D52: the engine variable `REAL_TRADING` opens REAL only when it is exactly
 * "enabled". Unset, empty, "true", "ENABLED" or anything else is closed. Production keeps it
 * "disabled" until the owner changes it in a PR of their own.
 */
export function isRealTradingOpen(settings: {
  readonly REAL_TRADING?: string | undefined;
}): boolean {
  return settings.REAL_TRADING === "enabled";
}

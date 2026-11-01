import { Schema } from "effect";
import {
  allowedModes,
  modeAllowed,
  type AllowedModes,
  type ModeAction,
  type ModeLocks,
} from "#lib/domain/modes.ts";

/** The trading mode a call serves; the Durable Object decides per action whether REAL is open (D52). */
export const Mode = Schema.Literals(["SIM", "REAL"]);
export type Mode = typeof Mode.Type;

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

/**
 * A per-pass Durable Object key (degraded condition, last good pass): SIM keeps the plain name, so
 * nothing stored before REAL changes, and every other mode gets its own, so two passes in one tick
 * never clear or read each other's state.
 */
export function modeKey(key: string, mode: Mode): string {
  return mode === "SIM" ? key : `${key}:${mode}`;
}

const MODE_LOCKS_KEY = "mode_locks";

/** The deployment switch and the client's flag as the Durable Object last read them. */
interface StoredModeLocks {
  readonly deploymentOpen: boolean;
  readonly clientEnabled: boolean;
}

/**
 * D1 owns the client flag and the environment owns the switch; this is only the copy the
 * synchronous passes read. The Durable Object rewrites it at the start of every alarm task and
 * request (index.ts), and the deployment half again when the instance is built, so a closed switch
 * never waits for a D1 read.
 */
export function recordModeLocks(storage: DurableObjectStorage, locks: StoredModeLocks): void {
  storage.kv.put(MODE_LOCKS_KEY, locks);
}

export function readModeLocks(storage: DurableObjectStorage): StoredModeLocks {
  return (
    storage.kv.get<StoredModeLocks>(MODE_LOCKS_KEY) ?? {
      deploymentOpen: false,
      clientEnabled: false,
    }
  );
}

/** The three locks the Durable Object can read synchronously: the stored switch and flag, and its own rows. */
export function currentModeLocks(storage: DurableObjectStorage): ModeLocks {
  const stored = readModeLocks(storage);
  // No need to look at the rows while the switch is closed.
  const hasOpenReal =
    stored.deploymentOpen &&
    storage.sql
      .exec<{ n: number }>(
        `SELECT (SELECT COUNT(*) FROM positions WHERE mode = 'REAL' AND status != 'CLOSED')
              + (SELECT COUNT(*) FROM intents WHERE mode = 'REAL'
                  AND state NOT IN ('FILLED', 'CANCELED', 'REJECTED')) AS n`,
      )
      .one().n > 0;
  return { ...stored, hasOpenReal };
}

/** What each kind of order may use right now (D52 locks 1 and 2). */
export function currentAllowedModes(storage: DurableObjectStorage): AllowedModes {
  return allowedModes(currentModeLocks(storage));
}

/** Whether an RPC of this kind may serve the mode now (`modeAllowed`). */
export function modeAllowedNow(
  storage: DurableObjectStorage,
  action: ModeAction,
  mode: Mode,
): boolean {
  return mode === "SIM" || modeAllowed(action, mode, currentModeLocks(storage));
}

/**
 * The modes the background passes (sync, reconcile, protection, trailing) serve: SIM always; REAL
 * when the deployment is open and the client's flag is on, or while a REAL position or unfinished
 * REAL intent remains, so exits and protections are never stranded (`allowedModes`, D52).
 */
export function activeModes(storage: DurableObjectStorage): readonly [Mode, ...Mode[]] {
  return currentAllowedModes(storage).exits.includes("REAL") ? ["SIM", "REAL"] : ["SIM"];
}

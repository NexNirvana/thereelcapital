import { Schema } from "effect";
import { allowedModes } from "#lib/domain/modes.ts";

/** REAL is decoded so it can be rejected by name; the RPC serves it only once its issue opens it (D52). */
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

/**
 * The modes the background passes (sync, reconcile, protection, trailing) serve: SIM always; REAL
 * when the deployment is open and the client's flag is on, or while a REAL position or unfinished
 * REAL intent remains, so exits and protections are never stranded (`allowedModes`, D52).
 */
export function activeModes(storage: DurableObjectStorage): readonly [Mode, ...Mode[]] {
  const locks = readModeLocks(storage);
  // No need to look at the rows while the switch is closed.
  if (!locks.deploymentOpen) return ["SIM"];
  const hasOpenReal =
    storage.sql
      .exec<{ n: number }>(
        `SELECT (SELECT COUNT(*) FROM positions WHERE mode = 'REAL' AND status != 'CLOSED')
              + (SELECT COUNT(*) FROM intents WHERE mode = 'REAL'
                  AND state NOT IN ('FILLED', 'CANCELED', 'REJECTED')) AS n`,
      )
      .one().n > 0;
  return allowedModes({ ...locks, hasOpenReal }).exits.includes("REAL") ? ["SIM", "REAL"] : ["SIM"];
}

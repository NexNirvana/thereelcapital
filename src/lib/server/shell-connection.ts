/**
 * The connection as the shell and the trader pages need it. The (app) layout reads it from the
 * engine once per load and `/operar` and `/conexion` take it with `await parent()`, so this is
 * the only shape that reaches the browser (layout data is serialized): fields are copied one by
 * one, never spread, so nothing the engine adds later leaks by accident.
 */
import type { ConnectionHealth } from "#lib/domain/connection.ts";

export type ShellConnection =
  | { readonly ok: false; readonly message: string }
  | {
      readonly ok: true;
      readonly view:
        | { readonly status: "NOT_CONNECTED" }
        | {
            readonly status: "CONNECTED";
            readonly health: ConnectionHealth;
            readonly entriesBlocked: boolean;
            readonly accounts: ReadonlyArray<{
              readonly accountId: string;
              readonly accountType: string;
            }>;
            readonly refreshExpiresAt: number | null;
          };
    };

/** What the engine returns; structural, so the extra fields it carries are simply not named. */
type EngineConnection =
  | { readonly ok: false; readonly message: string }
  | { readonly ok: true; readonly value: Extract<ShellConnection, { ok: true }>["view"] };

/** `null` when the engine could not be reached at all. */
export function shellConnection(result: EngineConnection | null): ShellConnection | null {
  if (result === null) return null;
  if (!result.ok) return { ok: false, message: result.message };
  const view = result.value;
  if (view.status !== "CONNECTED") return { ok: true, view: { status: view.status } };
  return {
    ok: true,
    view: {
      status: view.status,
      health: view.health,
      entriesBlocked: view.entriesBlocked,
      accounts: view.accounts.map(({ accountId, accountType }) => ({ accountId, accountType })),
      refreshExpiresAt: view.refreshExpiresAt,
    },
  };
}

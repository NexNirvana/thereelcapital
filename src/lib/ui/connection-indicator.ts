// What the top bar and the connection screen say about the TradeStation connection.
import type { ConnectionHealth } from "#lib/domain/connection.ts";

/** `null` is "not connected yet"; `undefined` is "could not be read", shown as unknown. */
export type IndicatorInput = ConnectionHealth | null | undefined;

export interface Indicator {
  /** The state alone, for a labelled row ("Conectado"). */
  readonly state: string;
  /** The top bar text, led by the broker's name. */
  readonly label: string;
  /** Filled dot only for a connection that works; text carries the meaning, not the colour. */
  readonly healthy: boolean;
  /** Shown as a link to the reconnect flow at /conexion. */
  readonly action: string | null;
}

const RECONNECT = "Reconectar con TradeStation";

const shown = (state: string, healthy: boolean, action: string | null): Indicator => ({
  state,
  label: `TradeStation ${state.charAt(0).toLowerCase()}${state.slice(1)}`,
  healthy,
  action,
});

export function indicatorFor(health: IndicatorInput): Indicator {
  if (health === undefined)
    return { state: "—", label: "TradeStation —", healthy: false, action: null };
  if (health === null) return shown("Sin conectar", false, "Conectar con TradeStation");
  switch (health.status) {
    case "ok":
      return shown("Conectado", true, null);
    case "expiring":
      return shown("Vence pronto", true, RECONNECT);
    case "expired":
      return shown("Venció", false, RECONNECT);
    case "revoked":
      return shown("Sin acceso", false, RECONNECT);
    case "error":
      return shown("Sin respuesta", false, RECONNECT);
  }
}

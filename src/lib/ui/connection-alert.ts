// The alert every signed-in screen shows while the TradeStation connection cannot be used, and the
// «sin verificar» wording of the screens that keep showing the last known data meanwhile.
import { brokerReachable, type ConnectionHealth } from "#lib/domain/connection.ts";
import type { ShellConnection } from "#lib/server/shell-connection.ts";
import { formatWhen } from "./history.ts";

export interface ConnectionAlert {
  readonly kind: "never" | "lost" | "pending";
  readonly title: string;
  /** What happened, then what cannot be done meanwhile. */
  readonly lines: readonly string[];
  readonly action: string;
  /** Last good sync (epoch ms), when known. */
  readonly since: number | null;
}

const BLOCKED =
  "No podemos verificar tus posiciones, precios ni órdenes, ni enviar nuevas, hasta que reconectes.";

function causeOf(health: ConnectionHealth): string {
  switch (health.status) {
    case "revoked":
      return "TradeStation rechazó o cerró la conexión.";
    case "expired":
      return "La conexión con TradeStation venció.";
    case "error":
      return "No pudimos renovar la conexión con TradeStation.";
    case "ok":
    case "expiring":
      return "TradeStation no confirma tus datos.";
  }
}

/**
 * `null` when the connection works, and also when the engine could not be read: the top bar shows
 * that case as unknown and an alert would claim more than we know.
 */
export function connectionAlert(connection: ShellConnection | null): ConnectionAlert | null {
  if (connection === null || !connection.ok) return null;
  const { view } = connection;
  if (view.status === "NOT_CONNECTED") {
    return {
      kind: "never",
      title: "Conecta tu cuenta de TradeStation para operar",
      lines: ["Sin la conexión no podemos ver tus posiciones ni precios, ni enviar órdenes."],
      action: "Conectar con TradeStation",
      since: null,
    };
  }
  // Never throws on a missing or bad time: an alert must not take the whole layout down.
  const since =
    typeof view.lastSyncAt === "number" && Number.isFinite(view.lastSyncAt)
      ? view.lastSyncAt
      : null;
  const lastGood = since === null ? [] : [`Última sincronización correcta: ${formatWhen(since)}.`];
  if (brokerReachable(view.health)) {
    // The token is fine but no sync pass has confirmed the state yet (a pass failed, or the
    // connection just changed): the data on screen is unverified, entries are on hold.
    if (!view.entriesBlocked) return null;
    return {
      kind: "pending",
      title: "TradeStation aún no confirma tus datos",
      lines: [
        "Estamos verificando tus posiciones y órdenes con TradeStation.",
        ...lastGood,
        "Hasta entonces no podemos verificarlas, ni enviar nuevas órdenes.",
      ],
      action: "Ver la conexión",
      since,
    };
  }
  return {
    kind: "lost",
    title: "La conexión con TradeStation no está activa",
    lines: [causeOf(view.health), ...lastGood, BLOCKED],
    action: "Reconectar con TradeStation",
    since,
  };
}

/** «Datos sin verificar desde 10:00 ET», or without the time when no pass ever completed. */
export function unverifiedLine(lastSyncAt: number | null): string {
  return lastSyncAt === null || !Number.isFinite(lastSyncAt)
    ? "Datos sin verificar"
    : `Datos sin verificar desde ${formatWhen(lastSyncAt)}`;
}

/** The sync time the screens that read the shell connection show as unverified; undefined = verified. */
export function unverifiedSince(connection: ShellConnection | null): number | null | undefined {
  const alert = connectionAlert(connection);
  return alert === null ? undefined : alert.since;
}

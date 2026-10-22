// How the admin overview words what the engine reports. The engine decides, this only translates.
import type { ConnectionKey } from "#lib/domain/overview.ts";
import { indicatorFor } from "./connection-indicator.ts";

export function connectionLabel(key: ConnectionKey): string {
  switch (key) {
    case "NOT_CONNECTED":
      return indicatorFor(null).state;
    case "UNAVAILABLE":
      return "No disponible";
    case "ok":
      return indicatorFor({ status: "ok" }).state;
    case "expiring":
      return indicatorFor({ status: "expiring", refreshExpiresAt: 0 }).state;
    case "expired":
      return indicatorFor({ status: "expired" }).state;
    case "revoked":
      return indicatorFor({ status: "revoked" }).state;
    case "error":
      return indicatorFor({ status: "error" }).state;
  }
}

/** The stop's verified state, as the position screen words it (docs/design-system.md). */
export function protectionLabel(state: string): string {
  switch (state) {
    case "verified":
      return "Activo";
    case "none":
      return "Sin activar";
    default:
      // An unrecognised state never claims verification.
      return "No verificado";
  }
}

/** Quantity still open: what was bought minus what was sold. */
export function openQty(position: { originalQty: number; soldQty: number }): number {
  return position.originalQty - position.soldQty;
}

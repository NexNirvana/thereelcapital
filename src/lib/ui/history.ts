// How the Historial screen words what the engine's `history` returns. The engine decides, this only
// translates; the state labels are the order-lifecycle states (docs/order-lifecycle.md).

import { formatPrice, formatSize } from "./new-entry.ts";

const STATE_LABELS: Readonly<Record<string, string>> = {
  ARMED: "Preparada",
  SENT: "Enviada",
  ACKNOWLEDGED: "Recibida",
  PARTIAL: "Parcial",
  FILLED: "Ejecutada",
  CANCEL_PENDING: "Cancelando",
  CANCELED: "Cancelada",
  REJECTED: "Rechazada",
  UNKNOWN: "No verificada",
};

export function stateLabel(state: string): string {
  return STATE_LABELS[state] ?? "Desconocida";
}

const KIND_LABELS: Readonly<Record<string, string>> = {
  entry: "Entrada",
  exit: "Salida",
  stop: "Stop",
  trailing: "Trailing",
  cancel: "Cancelación",
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

const EVENT_LABELS: Readonly<Record<string, string>> = {
  "broker.connected": "TradeStation conectado",
  "broker.disconnected": "TradeStation desconectado",
  "broker.authorize_started": "Autorización iniciada",
  "broker.refresh_failed": "No se pudo renovar la conexión",
  "broker.refresh_recovered": "Conexión renovada",
  "broker.token_exchange_failed": "TradeStation rechazó la autorización",
  "broker.state_rejected": "Enlace de autorización no válido",
  "broker.accounts_failed": "No se pudieron leer las cuentas",
  "entry.rejected": "Entrada rechazada",
  "entry.unknown": "Entrada sin confirmar",
  "entry.symbol_rejected": "Símbolo rechazado",
  "entry.quote_failed": "Cotización no disponible",
  "entry.details_failed": "Detalles del símbolo no disponibles",
  "reconcile.position_opened": "Posición abierta",
  "reconcile.position_closed": "Posición cerrada",
  "reconcile.position_adopted": "Posición externa incorporada",
  "reconcile.order_adopted": "Orden externa incorporada",
  "reconcile.external_sale": "Venta externa registrada",
  "reconcile.intent_updated": "Orden actualizada",
  "reconcile.unresolved": "Orden pendiente de verificar",
  "reconcile.armed_never_sent": "Orden preparada que no se envió",
  "sync.broker_error": "Error al sincronizar con TradeStation",
  "sync.items_skipped": "Órdenes o posiciones ajenas ignoradas",
  "sync.rate_limited": "TradeStation limitó las consultas",
  "sync.token_expired": "TradeStation rechazó o cerró la conexión: reconéctala",
  "sync.recovered": "Sincronización restablecida",
  "sync.unknown_pending": "Órdenes por verificar",
  "protection.stop_triggered": "Stop activado",
  "protection.trailing_triggered": "Trailing alcanzado",
  "protection.trailing_activated": "Trailing activado",
  "protection.expiry_triggered": "Cierre por vencimiento",
  "protection.expiry_close_skipped": "Cierre por vencimiento en espera",
  "protection.quotes_unavailable": "Cotizaciones no disponibles para el stop",
};

/** Events without a wording of their own stay readable without exposing internal codes. */
export function eventLabel(type: string): string {
  return EVENT_LABELS[type] ?? "Evento del sistema";
}

const OPERATION_LABELS: Readonly<Record<string, string>> = {
  orders: "órdenes",
  historicalOrders: "historial de órdenes",
  positions: "posiciones",
  symbolDetails: "detalles del símbolo",
  accounts: "cuentas",
};

/** The failing broker call and why, in words: no values, only the field a bad answer broke. */
function detailLabel(detail: string): string {
  if (detail === "invalid_response") return "respuesta no válida";
  if (detail === "network") return "sin conexión";
  if (detail.startsWith("http_5")) return "error de TradeStation";
  if (detail.startsWith("invalid_value:")) return `valor no válido en ${detail.slice(14)}`;
  return "rechazada";
}

/**
 * An event's wording; a sync failure carries which read failed and why, e.g.
 * «Error al sincronizar con TradeStation (órdenes: respuesta no válida)».
 */
export function eventText(event: {
  readonly type: string;
  readonly operation?: string | null | undefined;
  readonly detail?: string | null | undefined;
}): string {
  const label = eventLabel(event.type);
  if (event.operation == null) return label;
  const operation = OPERATION_LABELS[event.operation] ?? "TradeStation";
  return event.detail == null
    ? `${label} (${operation})`
    : `${label} (${operation}: ${detailLabel(event.detail)})`;
}

export function levelLabel(level: string): string {
  return level === "error" ? "Error" : level === "warn" ? "Aviso" : "Info";
}

const when = new Intl.DateTimeFormat("es", {
  dateStyle: "medium",
  timeStyle: "short",
  hourCycle: "h23",
  timeZone: "America/New_York",
});

/** "4 nov 2026, 10:00 ET": market time, whatever the browser's own zone. */
export function formatWhen(epochMs: number): string {
  return `${when.format(new Date(epochMs))} ET`;
}

/** "10/50": what filled of what was asked. */
export function fillLine(filledQty: number, qty: number): string {
  return `${filledQty}/${qty}`;
}

/** The average fill price, or a dash until something filled. */
export function fillPrice(avgFillPrice: number | null): string {
  return avgFillPrice === null ? "—" : formatPrice(avgFillPrice);
}

/**
 * The SIZE an entry was sized with, and «−25%» when the client chose it (D51); a dash for any other
 * order. Both fields are optional: an engine that predates them sends neither (deploy skew).
 */
export function sizeLine(order: {
  readonly kind: string;
  readonly size_applied?: number | null;
  readonly size_choice?: string | null;
}): string {
  if (order.kind !== "entry" || order.size_applied == null) return "—";
  const size = formatSize(order.size_applied);
  return order.size_choice === "down25" ? `${size} · −25%` : size;
}

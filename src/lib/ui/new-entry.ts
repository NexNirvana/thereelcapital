// What the Nueva entrada screen says about an entry the engine prepared or refused. The codes are
// the engine's stable ones (engine/src/entries.ts); the engine decides, this only words it.

import { formatUsd } from "#lib/domain/money.ts";

/** Spanish reason for each code the engine can return; one line the client can act on. */
const BLOCK_MESSAGES: Readonly<Record<string, string>> = {
  NO_ACCOUNT: "No hay una cuenta de TradeStation habilitada para operar. Revisa tu conexión.",
  NOT_CONNECTED: "Conecta tu cuenta de TradeStation para operar.",
  CONNECTION_UNUSABLE: "La conexión con TradeStation no está disponible. Reconéctala para operar.",
  RECONCILIATION_PENDING:
    "Estamos conciliando tus órdenes con TradeStation. Las entradas se reanudan al terminar.",
  SIZE_UNAVAILABLE: "Tu SIZE no está configurado. Avisa al administrador.",
  DAILY_ENTRY_LIMIT: "Ya usaste las entradas de hoy.",
  OPEN_POSITION_LIMIT: "Ya tienes el máximo de posiciones abiertas.",
  QUOTE_MISSING: "No hay cotización disponible para este instrumento.",
  QUOTE_STALE: "La cotización no está al día. Inténtalo de nuevo.",
  HALTED: "El instrumento está en pausa de negociación.",
  SYMBOL_DETAILS_MISSING: "No encontramos ese símbolo en TradeStation.",
  BELOW_MINIMUM: "Con tu SIZE no alcanza para la cantidad mínima.",
  ACCOUNT_NOT_OWNED: "La cuenta elegida no es una de tus cuentas conectadas.",
  ACCOUNT_NOT_ACTIVE: "La cuenta elegida no está activa.",
  ACCOUNT_TYPE_NOT_ALLOWED: "Esta cuenta no puede operar aquí.",
  INSTRUMENT_OUT_OF_SCOPE: "Este instrumento no está disponible para operar.",
  OUTSIDE_REGULAR_SESSION: "El mercado está cerrado. Solo operas en la sesión regular.",
  POSITION_ALREADY_OPEN: "Ya tienes una posición u orden abierta en este símbolo.",
};

const GENERIC_BLOCK = "No podemos preparar esta entrada ahora.";

/** The first reason is the one shown; the engine lists them in the order they apply. */
export function blockMessage(reasons: readonly string[]): string {
  const [first] = reasons;
  return (first !== undefined && BLOCK_MESSAGES[first]) || GENERIC_BLOCK;
}

export interface Limits {
  readonly positions: number;
  readonly maxPositions: number;
  readonly entriesToday: number;
  readonly maxEntries: number;
}

export function limitsLine(limits: Limits): string {
  return `${limits.positions}/${limits.maxPositions} posiciones · ${limits.entriesToday}/${limits.maxEntries} entradas hoy`;
}

/** "20,000" and "00": the exact micro-dollar value from the domain, with thousands separators. */
function usdParts(micros: number): { whole: string; cents: string } {
  const [whole = "0", cents = "00"] = formatUsd(micros).slice(1).split(".");
  return { whole: whole.replace(/\B(?=(\d{3})+$)/g, ","), cents };
}

/** "US$20,000": the SIZE a client was given, in whole dollars unless it has cents. */
export function formatSize(micros: number): string {
  const { whole, cents } = usdParts(micros);
  return cents === "00" ? `US$${whole}` : `US$${whole}.${cents}`;
}

/** "US$4.00": a price, at least two decimals and every micro-dollar kept. */
export function formatPrice(micros: number): string {
  const { whole, cents } = usdParts(micros);
  return `US$${whole}.${cents}`;
}

/** "50 contratos" / "100 acciones", singular for one. */
export function formatQuantity(qty: number, assetType: "equity" | "option"): string {
  const [one, many] = assetType === "option" ? ["contrato", "contratos"] : ["acción", "acciones"];
  return `${qty} ${qty === 1 ? one : many}`;
}

/** Why a connection that is not usable blocks entries, as an engine code (see `blockMessage`). */
export function connectionBlockCode(
  view: { status: "NOT_CONNECTED" } | { status: "CONNECTED"; health: { status: string } },
): "NOT_CONNECTED" | "CONNECTION_UNUSABLE" | "RECONCILIATION_PENDING" {
  if (view.status === "NOT_CONNECTED") return "NOT_CONNECTED";
  // Entries are blocked with a reachable broker only while orders are being reconciled.
  return view.health.status === "ok" || view.health.status === "expiring"
    ? "RECONCILIATION_PENDING"
    : "CONNECTION_UNUSABLE";
}

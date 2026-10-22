// How the Posiciones screen words what the engine's `positions` returns. The engine decides; this
// only translates and formats. Nothing here computes a quantity to sell.

import type { PendingExitView, PositionView } from "#lib/domain/positions-view.ts";
import { trailingEligible } from "#lib/domain/stop.ts";
import { SCALE_OUT_STEPS, type ScaleOutStepState } from "#lib/domain/scaleout.ts";
import { kindLabel, stateLabel } from "./history.ts";
import { formatPrice, formatQuantity } from "./new-entry.ts";

/** Spanish reason for each code `exit` or `cancel` can block with; one line the client can act on. */
const BLOCK_MESSAGES: Readonly<Record<string, string>> = {
  NOT_CONNECTED: "Conecta tu cuenta de TradeStation para operar.",
  CONNECTION_UNUSABLE: "La conexión con TradeStation no está disponible. Reconéctala para operar.",
  POSITION_NOT_FOUND: "Esa posición ya no está abierta.",
  STEP_NOT_AVAILABLE: "Ese paso ya se usó o está en curso.",
  NOTHING_AVAILABLE: "No hay cantidad disponible para vender: hay órdenes de salida en curso.",
  UNKNOWN_INTENT_PENDING:
    "Una orden de esta posición está en verificación. Espera a que termine antes de enviar otra.",
  OUTSIDE_REGULAR_SESSION: "El mercado está cerrado. Solo operas en la sesión regular.",
  INTENT_NOT_FOUND: "No encontramos esa orden.",
  NOT_CANCELABLE: "Esa orden ya no se puede cancelar.",
  NOT_ELIGIBLE: "Todavía no vendiste lo suficiente para activar el trailing.",
  EXIT_PENDING: "Hay una orden de salida en curso. Espera a que termine para activar el trailing.",
  ALREADY_ACTIVE: "El trailing ya está activo en esta posición.",
  QUOTE_UNAVAILABLE: "No hay un precio actual para activar el trailing. Inténtalo de nuevo.",
};

const GENERIC_BLOCK = "No pudimos enviar la orden ahora.";

/** The first reason is the one shown; the engine lists them in the order they apply. */
export function exitBlockMessage(reasons: readonly string[]): string {
  const [first] = reasons;
  return (first !== undefined && BLOCK_MESSAGES[first]) || GENERIC_BLOCK;
}

/** "15 contratos" / "1 contrato" / "15 acciones". */
export function formatUnits(qty: number, position: Pick<PositionView, "option">): string {
  return formatQuantity(qty, position.option === null ? "equity" : "option");
}

/** «15 contratos restantes», «1 acción restante». */
export function remainingLine(position: PositionView): string {
  const qty = remainingQty(position);
  return `${formatUnits(qty, position)} ${qty === 1 ? "restante" : "restantes"}`;
}

/** «ALL OUT · Cierra los 15 contratos restantes» (shares are feminine: «las 198 acciones»). */
export function allOutHint(position: PositionView, qty: number): string {
  const units = position.option === null ? "acciones" : "contratos";
  if (qty === 1)
    return `ALL OUT · Cierra ${position.option === null ? "la acción" : "el contrato"} restante`;
  return `ALL OUT · Cierra ${position.option === null ? "las" : "los"} ${qty} ${units} restantes`;
}

/** «ALL OUT · 15 contratos»: the short caption of the mobile design. */
export function allOutShortHint(position: PositionView, qty: number): string {
  return `ALL OUT · ${formatUnits(qty, position)}`;
}

const EXPIRY = new Intl.DateTimeFormat("es", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** "20 nov 2026" from a plain YYYY-MM-DD, whatever the browser or server time zone. */
export function formatExpiration(isoDay: string): string {
  return EXPIRY.format(new Date(`${isoDay}T00:00:00Z`)).replaceAll(".", "");
}

/** "600" or "602.5": the strike without trailing zeros. */
function formatStrike(micros: number): string {
  return formatPrice(micros)
    .replace(/^US\$/, "")
    .replace(/\.00$/, "")
    .replace(/(\.\d)0$/, "$1");
}

/** The line above the detail: «SPY · Call 600» for an option, the ticker for shares. */
export function switcherLabel(position: PositionView): string {
  const { option } = position;
  return option === null
    ? position.symbol
    : `${option.underlying} · ${option.right === "call" ? "Call" : "Put"} ${formatStrike(option.strikeMicros)}`;
}

/** «Call 600 · 20 nov 2026» for an option, «Acciones» for shares. */
export function instrumentLine(position: PositionView): string {
  const { option } = position;
  if (option === null) return "Acciones";
  return `${option.right === "call" ? "Call" : "Put"} ${formatStrike(option.strikeMicros)} · ${formatExpiration(option.expiration)}`;
}

export const headline = (position: PositionView) => position.option?.underlying ?? position.symbol;

export function remainingQty(position: PositionView): number {
  return position.originalQty - position.soldQty;
}

/** Whole percent of the original quantity already sold; 100 only when nothing remains. */
export function soldPercent(position: PositionView): number {
  const share = Math.floor((position.soldQty * 100) / position.originalQty);
  return position.soldQty < position.originalQty ? Math.min(share, 99) : 100;
}

export interface StepView {
  readonly index: number;
  readonly pct: number;
  readonly state: ScaleOutStepState;
  /** Accessible name, e.g. «Paso 1, 30 %, vendido». */
  readonly name: string;
}

const STATE_WORDS: Record<ScaleOutStepState, string> = {
  available: "disponible",
  pending: "en curso",
  done: "vendido",
  done_zero: "0 por redondeo",
};

export function stepViews(position: PositionView): StepView[] {
  return SCALE_OUT_STEPS.map((pct, index) => {
    const state = position.steps[index] ?? "pending";
    return { index, pct, state, name: `Paso ${index + 1}, ${pct}%, ${STATE_WORDS[state]}` };
  });
}

/** «Porcentajes sobre los 50 contratos iniciales», «…sobre las 198 acciones iniciales». */
export function stepBasisHint(position: PositionView): string {
  const { originalQty: qty } = position;
  if (qty === 1) return `Porcentajes sobre la cantidad inicial: ${formatUnits(qty, position)}`;
  return `Porcentajes sobre ${position.option === null ? "las" : "los"} ${formatUnits(qty, position)} iniciales`;
}

/** «Paso 3 (10%): 0 contratos por redondeo»; the unit follows the instrument. */
export function roundedToZeroLine(step: StepView, position: Pick<PositionView, "option">): string {
  return `Paso ${step.index + 1} (${step.pct}%): 0 ${position.option === null ? "acciones" : "contratos"} por redondeo`;
}

/** Whole steps the engine marked as rounding to nothing: nothing was sent for them. */
export const roundedToZero = (steps: readonly StepView[]): StepView[] =>
  steps.filter((step) => step.state === "done_zero");

/** Only a stop the engine verified is «Activo»; every other stored state is said as what it is. */
export function stopStatus(protectionState: string): { label: string; active: boolean } {
  switch (protectionState) {
    case "verified":
      return { label: "Activo", active: true };
    case "unverified":
      return { label: "Sin verificar", active: false };
    default:
      return { label: "Inactivo", active: false };
  }
}

export interface TrailingStatus {
  /** The engine holds a trailing level for this position. */
  readonly active: boolean;
  /** The Activar button may be enabled; the engine checks again on submit. */
  readonly canActivate: boolean;
}

/**
 * Whether Activar is offered. This only enables or disables the control: the engine decides
 * (eligibility from confirmed sales, nothing pending, a live bid) and answers a reason if not.
 */
export function trailingStatus(
  position: PositionView,
  pending: readonly PendingExitView[],
): TrailingStatus {
  const active = position.trailingPct !== null;
  const open = pending.some((order) => order.positionId === position.id);
  return {
    active,
    canActivate:
      !active &&
      !open &&
      trailingEligible({
        originalQty: position.originalQty,
        soldQty: position.soldQty,
        trailingUnlockPct: position.trailingUnlockPct,
      }),
  };
}

/** Orders are worded as the history screen words them, so a state reads the same everywhere. */
export { kindLabel as pendingKindLabel, stateLabel as pendingStateLabel };

/** «50 iniciales · 35 vendidos», «1 inicial · 1 vendido». */
export function countsLine(position: PositionView): string {
  const { originalQty: original, soldQty: sold } = position;
  return `${original} ${original === 1 ? "inicial" : "iniciales"} · ${sold} ${sold === 1 ? "vendido" : "vendidos"}`;
}

/**
 * What ALL OUT would sell: what remains less the unfilled part of the position's working orders,
 * which the engine holds back too. The engine still decides; this only words and disables.
 */
export function sellableQty(position: PositionView, pending: readonly PendingExitView[]): number {
  const held = pending
    .filter((order) => order.positionId === position.id)
    .reduce((total, order) => total + Math.max(order.qty - order.filledQty, 0), 0);
  return Math.max(0, remainingQty(position) - held);
}

export type ActionOutcome =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly title: string; readonly message: string };

/** What the engine's intent state says about a sell it just placed (`PLACED`). */
export function exitOutcome(state: string): ActionOutcome {
  switch (state) {
    case "REJECTED":
      return {
        ok: false,
        title: "Orden rechazada",
        message: "TradeStation no tomó la orden. No se vendió nada.",
      };
    case "UNKNOWN":
      return {
        ok: false,
        title: "Verificando la orden",
        message:
          "No recibimos respuesta de TradeStation. Esto no es un fallo: estamos verificando si la orden existe. No la vuelvas a enviar.",
      };
    default:
      return { ok: true, message: "Orden de salida enviada." };
  }
}

/** The state after a cancel request: only CANCEL_PENDING means the broker took it. */
export function cancelOutcome(state: string): ActionOutcome {
  return state === "CANCEL_PENDING"
    ? {
        ok: true,
        message: "Pedimos la cancelación a TradeStation. Te avisamos cuando se confirme.",
      }
    : {
        ok: false,
        title: "No se canceló la orden",
        message: "TradeStation no tomó la cancelación. Inténtalo de nuevo.",
      };
}

// How the order review screens word an entry intent's state (docs/order-lifecycle.md#intents).
// The engine owns the state; this only labels it. «Ejecutada» belongs to FILLED alone.

export interface IntentView {
  readonly state: string;
  readonly qty: number;
  readonly filledQty: number;
}

export interface StateCopy {
  readonly label: string;
  readonly detail: string;
  /** No further change will come from the broker: polling can stop. */
  readonly terminal: boolean;
}

/** Terminal for an entry. UNKNOWN is not: reconciliation will resolve it. */
const TERMINAL = new Set(["FILLED", "REJECTED", "CANCELED"]);

export const isTerminal = (state: string): boolean => TERMINAL.has(state);

export function stateCopy(intent: IntentView): StateCopy {
  const terminal = isTerminal(intent.state);
  switch (intent.state) {
    case "ARMED":
    case "SENT":
      return {
        label: "Enviada",
        detail: "Enviamos la orden a TradeStation. Aún no tenemos su respuesta.",
        terminal,
      };
    case "ACKNOWLEDGED":
      return {
        label: "Recibida por TradeStation",
        detail: "TradeStation aceptó la orden. Todavía no se ejecuta.",
        terminal,
      };
    case "PARTIAL":
      return {
        label: "Ejecución parcial",
        detail: `Se ejecutaron ${intent.filledQty} de ${intent.qty}. El resto sigue abierto.`,
        terminal,
      };
    case "FILLED":
      return {
        label: "Ejecutada",
        detail: `Se ejecutaron ${intent.filledQty} de ${intent.qty}.`,
        terminal,
      };
    case "REJECTED":
      return {
        label: "Rechazada",
        detail:
          intent.filledQty > 0
            ? `TradeStation rechazó el resto. Se ejecutaron ${intent.filledQty} de ${intent.qty}.`
            : "TradeStation no tomó la orden. No se ejecutó nada.",
        terminal,
      };
    case "CANCELED":
      return {
        label: "Cancelada",
        detail:
          intent.filledQty > 0
            ? `Se canceló el resto. Se ejecutaron ${intent.filledQty} de ${intent.qty}.`
            : "La orden se canceló. No se ejecutó nada.",
        terminal,
      };
    case "UNKNOWN":
      return {
        label: "Verificando",
        detail:
          "No recibimos respuesta de TradeStation. Esto no es un fallo: estamos verificando si la orden existe. No la vuelvas a enviar.",
        terminal,
      };
    default:
      return {
        label: "En proceso",
        detail: "Estamos consultando el estado de la orden en TradeStation.",
        terminal: false,
      };
  }
}

// Scripted outcomes for the local simulation's development symbols, so a browser test can walk an
// order through each ending without a way to reach the simulation from outside the Worker. Only the
// development configuration uses it, and that is reachable only with BROKER=local-sim and
// ENVIRONMENT development or test (select.ts); it never touches TradeStation.

import { Effect } from "effect";
import type { BrokerAdapterShape } from "../adapter.ts";
import type { LocalSim, SimSymbol } from "./sim.ts";

const usd = (dollars: number) => dollars * 1_000_000;

/** Every scripted symbol trades at bid 100 / ask 101, like MSFT. */
const scripted = (symbol: string): SimSymbol => ({
  symbol,
  assetType: "equity",
  bid: usd(100),
  ask: usd(101),
});

/** Symbol to the ending its next order gets. MSFT fills at the next broker call. */
export const SCENARIO_SYMBOLS = {
  /** Acknowledged now, filled in full a few seconds later. */
  SLOW: "delayed fill",
  /** 50 shares fill, the rest stays open. */
  PART: "partial fill",
  /** Acknowledged, then rejected by the broker. */
  RJCT: "reject after ack",
  /** The order exists but the response is lost: the entry is UNKNOWN until reconciled. */
  DROP: "dropped response",
} as const;

export const scenarioSymbols = (): SimSymbol[] => Object.keys(SCENARIO_SYMBOLS).map(scripted);

/** Wraps the simulation's adapter so placing an order first arms the ending its symbol names, and only for that order. */
export function withScenarios(sim: LocalSim): BrokerAdapterShape {
  const { adapter } = sim;
  return {
    ...adapter,
    placeOrder: (request) =>
      Effect.suspend(() => {
        sim.setFill({ kind: "instant" });
        switch (request.symbol) {
          case "SLOW":
            sim.setFill({ kind: "delayed", afterMs: 8_000 });
            break;
          case "PART":
            // Always short of the order, so it cannot fill in full whatever the quantity.
            sim.setFill({ kind: "partial", qty: Math.min(50, Math.floor(request.quantity / 2)) });
            break;
          case "RJCT":
            sim.setFill({ kind: "delayed", afterMs: 60_000 });
            sim.inject({ kind: "rejectAfterAck" });
            break;
          case "DROP":
            sim.inject({ kind: "dropPlaceResponse" });
            break;
        }
        // An outcome belongs to this one order: if validation refuses it or it repeats a confirm
        // id, the fault must not wait around for the next order.
        return adapter.placeOrder(request).pipe(Effect.ensuring(Effect.sync(sim.clearFaults)));
      }),
  };
}

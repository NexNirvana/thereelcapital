// Which BrokerAdapter an engine runs with. The local simulation is opt-in and fails closed: it
// needs an explicit BROKER=local-sim and an ENVIRONMENT that is exactly "development" or "test",
// so a missing or production ENVIRONMENT can never select it. The reverse holds too: ENVIRONMENT
// "test" can never select TradeStation.
import { allowsTestAffordances } from "#lib/domain/environment.ts";

export type BrokerChoice =
  | { readonly ok: true; readonly broker: "tradestation" | "local-sim" }
  | {
      readonly ok: false;
      readonly reason: "LOCAL_SIM_OUTSIDE_DEVELOPMENT" | "UNKNOWN_BROKER" | "TRADESTATION_IN_TEST";
    };

export interface BrokerSettings {
  readonly BROKER?: string | undefined;
  readonly ENVIRONMENT?: string | undefined;
}

export function selectBroker(settings: BrokerSettings): BrokerChoice {
  switch (settings.BROKER) {
    case undefined:
    case "tradestation":
      // A test deployment (the e2e engine opens REAL_TRADING, D52) must never reach a TradeStation
      // host, whatever BROKER a shell or .dev.vars overrides it with.
      return settings.ENVIRONMENT === "test"
        ? { ok: false, reason: "TRADESTATION_IN_TEST" }
        : { ok: true, broker: "tradestation" };
    case "local-sim":
      return allowsTestAffordances(settings.ENVIRONMENT)
        ? { ok: true, broker: "local-sim" }
        : { ok: false, reason: "LOCAL_SIM_OUTSIDE_DEVELOPMENT" };
    default:
      return { ok: false, reason: "UNKNOWN_BROKER" };
  }
}

// Which BrokerAdapter an engine runs with. The local simulation is opt-in and fails closed: it
// needs an explicit BROKER=local-sim and an ENVIRONMENT that is exactly "development" or "test",
// so a missing or production ENVIRONMENT can never select it.
import { allowsTestAffordances } from "#lib/domain/environment.ts";

export type BrokerChoice =
  | { readonly ok: true; readonly broker: "tradestation" | "local-sim" }
  | { readonly ok: false; readonly reason: "LOCAL_SIM_OUTSIDE_DEVELOPMENT" | "UNKNOWN_BROKER" };

export interface BrokerSettings {
  readonly BROKER?: string | undefined;
  readonly ENVIRONMENT?: string | undefined;
}

export function selectBroker(settings: BrokerSettings): BrokerChoice {
  switch (settings.BROKER) {
    case undefined:
    case "tradestation":
      return { ok: true, broker: "tradestation" };
    case "local-sim":
      return allowsTestAffordances(settings.ENVIRONMENT)
        ? { ok: true, broker: "local-sim" }
        : { ok: false, reason: "LOCAL_SIM_OUTSIDE_DEVELOPMENT" };
    default:
      return { ok: false, reason: "UNKNOWN_BROKER" };
  }
}

// The time the engine acts at. Always the real clock, except where the local simulation is
// allowed (selectBroker): there TEST_NOW (an ISO instant) pins it, so a spec can run inside a
// regular session at any hour. Production can never take the override, whatever vars are set.
import { selectBroker, type BrokerSettings } from "./broker/select.ts";

export interface ClockSettings extends BrokerSettings {
  readonly TEST_NOW?: string | undefined;
}

export function engineNow(settings: ClockSettings, realNow: number = Date.now()): number {
  if (settings.TEST_NOW === undefined) return realNow;
  const choice = selectBroker(settings);
  if (!choice.ok || choice.broker !== "local-sim") return realNow;
  const pinned = Date.parse(settings.TEST_NOW);
  return Number.isNaN(pinned) ? realNow : pinned;
}

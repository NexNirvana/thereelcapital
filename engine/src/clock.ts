// The time the engine acts at. Always the real clock, except where the local simulation is
// allowed (selectBroker): there TEST_NOW (an ISO instant) pins it, so a spec can run inside a
// regular session at any hour. It never moves alarm due times or retries: the alarm runs on real
// time and a pinned instant never advances, so those use the coordinator's real #now(). Production can never take the override, whatever vars are set.
import { selectBroker, type BrokerSettings } from "./broker/select.ts";

export interface ClockSettings extends BrokerSettings {
  readonly TEST_NOW?: string | undefined;
  readonly TEST_SYNC_MS?: string | undefined;
}

export function engineNow(settings: ClockSettings, realNow: number = Date.now()): number {
  if (settings.TEST_NOW === undefined) return realNow;
  const choice = selectBroker(settings);
  if (!choice.ok || choice.broker !== "local-sim") return realNow;
  const pinned = Date.parse(settings.TEST_NOW);
  return Number.isNaN(pinned) ? realNow : pinned;
}

// The pause before the next sync tick. The local simulation may shorten it with TEST_SYNC_MS so
// e2e specs need not wait out the production tick; production can never take the override.
export function syncDelayMs(settings: ClockSettings, productionMs: number): number {
  if (settings.TEST_SYNC_MS === undefined) return productionMs;
  const choice = selectBroker(settings);
  if (!choice.ok || choice.broker !== "local-sim") return productionMs;
  const shortened = Number(settings.TEST_SYNC_MS);
  return Number.isInteger(shortened) && shortened > 0
    ? Math.min(shortened, productionMs)
    : productionMs;
}

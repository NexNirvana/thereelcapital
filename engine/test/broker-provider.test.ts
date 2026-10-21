import { describe, expect, it } from "vitest";
import { resolveBroker } from "../src/broker/provider.ts";
import { okToken } from "./tradestation/helpers.ts";

const base = { userId: "provider-user", accessToken: okToken, now: () => 0 };

describe("resolveBroker", () => {
  it("is TradeStation SIM by default and in production", () => {
    for (const settings of [{}, { BROKER: "tradestation", ENVIRONMENT: "production" }]) {
      const resolved = resolveBroker({ ...base, settings });
      expect(resolved.ok && resolved.broker.source).toBe("tradestation-sim");
    }
  });

  it("uses the local simulation only in development or test", () => {
    for (const ENVIRONMENT of ["development", "test"]) {
      const resolved = resolveBroker({ ...base, settings: { BROKER: "local-sim", ENVIRONMENT } });
      expect(resolved.ok && resolved.broker.source).toBe("local-sim");
    }
  });

  it("refuses the local simulation anywhere else, and unknown brokers", () => {
    for (const settings of [
      { BROKER: "local-sim", ENVIRONMENT: "production" },
      { BROKER: "local-sim" },
      { BROKER: "live" },
    ]) {
      expect(resolveBroker({ ...base, settings }).ok).toBe(false);
    }
  });
});

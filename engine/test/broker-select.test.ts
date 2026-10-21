import { describe, expect, it } from "vitest";
import { selectBroker } from "../src/broker/select.ts";

describe("selectBroker", () => {
  it("defaults to TradeStation", () => {
    expect(selectBroker({})).toEqual({ ok: true, broker: "tradestation" });
    expect(selectBroker({ ENVIRONMENT: "production" })).toEqual({
      ok: true,
      broker: "tradestation",
    });
  });

  it.each(["development", "test"])("allows the local simulation in %s", (ENVIRONMENT) => {
    expect(selectBroker({ BROKER: "local-sim", ENVIRONMENT })).toEqual({
      ok: true,
      broker: "local-sim",
    });
  });

  it.each([undefined, "production", "staging", ""])(
    "refuses the local simulation when ENVIRONMENT is %j",
    (ENVIRONMENT) => {
      expect(selectBroker({ BROKER: "local-sim", ENVIRONMENT })).toEqual({
        ok: false,
        reason: "LOCAL_SIM_OUTSIDE_DEVELOPMENT",
      });
    },
  );

  it("rejects an unknown broker name", () => {
    expect(selectBroker({ BROKER: "live", ENVIRONMENT: "development" })).toEqual({
      ok: false,
      reason: "UNKNOWN_BROKER",
    });
  });
});

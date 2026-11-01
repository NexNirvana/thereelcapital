import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { resolveBroker } from "../src/broker/provider.ts";
import { okToken } from "./tradestation/helpers.ts";

const base = {
  mode: "SIM" as const,
  realTrading: false,
  userId: "provider-user",
  accessToken: okToken,
  now: () => 0,
};

describe("resolveBroker", () => {
  it("is TradeStation SIM by default and in production", () => {
    for (const settings of [{}, { BROKER: "tradestation", ENVIRONMENT: "production" }]) {
      const resolved = resolveBroker({ ...base, settings });
      expect(resolved.ok && resolved.broker.source).toBe("tradestation-sim");
    }
  });

  it("refuses REAL with the switch closed and builds it only when open", () => {
    const closed = resolveBroker({ ...base, mode: "REAL", settings: {} });
    expect(closed).toEqual({ ok: false, reason: "REAL_TRADING_DISABLED" });
    const open = resolveBroker({ ...base, mode: "REAL", realTrading: true, settings: {} });
    expect(open.ok && open.broker.source).toBe("tradestation-real");
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

  it("gives REAL its own local simulation and never builds a TradeStation transport", async () => {
    const settings = { BROKER: "local-sim", ENVIRONMENT: "test" };
    const ids = async (mode: "SIM" | "REAL") => {
      // Even with the switch open: the choice of broker comes first.
      const resolved = resolveBroker({ ...base, mode, realTrading: true, settings });
      if (!resolved.ok) throw new Error(resolved.reason);
      expect(resolved.broker.source).toBe("local-sim");
      return (await Effect.runPromise(resolved.broker.accounts())).map((a) => a.accountId);
    };
    expect(await ids("SIM")).toEqual(["SIM-1"]);
    expect(await ids("REAL")).toEqual(["REAL-1"]);
  });
});

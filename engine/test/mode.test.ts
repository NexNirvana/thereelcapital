import { describe, expect, it } from "vitest";
import { activeModes, isRealTradingOpen } from "../src/mode.ts";

describe("activeModes", () => {
  it("serves SIM only until REAL mode is built", () => {
    expect(activeModes()).toEqual(["SIM"]);
  });
});

describe("isRealTradingOpen", () => {
  it("opens only for the exact string enabled", () => {
    expect(isRealTradingOpen({ REAL_TRADING: "enabled" })).toBe(true);
    for (const value of [
      undefined,
      "",
      "disabled",
      "ENABLED",
      "Enabled",
      "true",
      "1",
      " enabled",
      "enabled ",
    ]) {
      expect(isRealTradingOpen({ REAL_TRADING: value })).toBe(false);
    }
    expect(isRealTradingOpen({})).toBe(false);
  });
});

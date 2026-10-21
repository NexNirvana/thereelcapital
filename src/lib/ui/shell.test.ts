import { describe, expect, it } from "bun:test";
import { formatMarketClock, maskAccount, msToNextMinute } from "./shell";

describe("maskAccount", () => {
  it("shows only the last four characters", () => {
    expect(maskAccount("SIM1234567F")).toBe("•• 567F");
    expect(maskAccount("11224821")).toBe("•• 4821");
  });
});

describe("formatMarketClock", () => {
  it("shows New York time in winter (EST, UTC-5)", () => {
    expect(formatMarketClock(new Date("2026-01-15T15:42:00Z"))).toBe("10:42 ET");
  });

  it("shows New York time in summer (EDT, UTC-4)", () => {
    expect(formatMarketClock(new Date("2026-07-15T14:42:00Z"))).toBe("10:42 ET");
  });

  it("uses a 24-hour clock", () => {
    expect(formatMarketClock(new Date("2026-07-15T20:05:00Z"))).toBe("16:05 ET");
  });
});

describe("msToNextMinute", () => {
  it("waits for the next minute boundary", () => {
    expect(msToNextMinute(new Date("2026-01-15T15:42:15.250Z"))).toBe(44_750);
    expect(msToNextMinute(new Date("2026-01-15T15:42:00.000Z"))).toBe(60_000);
  });
});

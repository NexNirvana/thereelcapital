import { describe, expect, it } from "bun:test";
import {
  contractLabel,
  formatAge,
  formatExpiration,
  formatQuote,
  formatStrike,
  isStale,
} from "./option-chain.ts";

describe("option chain wording", () => {
  it("shows strikes in dollars, keeping cents only when there are some", () => {
    expect(formatStrike(400_000_000)).toBe("400");
    expect(formatStrike(402_500_000)).toBe("402.50");
    expect(formatStrike(12_345_600)).toBe("12.3456");
  });

  it("shows quotes with at least two decimals and every micro-dollar", () => {
    expect(formatQuote(3_900_000)).toBe("3.90");
    expect(formatQuote(1_234_500)).toBe("1.2345");
    expect(formatQuote(1_250_000_000)).toBe("1,250.00");
  });

  it("words an expiration date without a time zone shift", () => {
    expect(formatExpiration("2026-11-20")).toBe("20 nov 2026");
    expect(formatExpiration("2026-01-02")).toBe("2 ene 2026");
  });

  it("names the contract apart from its underlying", () => {
    expect(contractLabel({ right: "call", strike: 400_000_000, expiration: "2026-11-20" })).toBe(
      "Call 400 · 20 nov 2026",
    );
  });

  it("words the age of a snapshot and calls an old one out of date", () => {
    expect(formatAge(0)).toBe("hace 0 s");
    expect(formatAge(12_400)).toBe("hace 12 s");
    expect(formatAge(185_000)).toBe("hace 3 min");
    expect(isStale(10_000)).toBe(false);
    expect(isStale(31_000)).toBe(true);
  });
});

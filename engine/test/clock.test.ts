import { describe, expect, it } from "vitest";
import { engineNow } from "../src/clock.ts";

const PINNED = "2026-11-04T15:00:00Z";
const pinnedMs = Date.parse(PINNED);

describe("engineNow", () => {
  it("is the real clock when nothing is pinned", () => {
    expect(engineNow({ BROKER: "local-sim", ENVIRONMENT: "test" }, 42)).toBe(42);
  });

  it.each(["development", "test"])("honours TEST_NOW with the local sim in %s", (ENVIRONMENT) => {
    expect(engineNow({ BROKER: "local-sim", ENVIRONMENT, TEST_NOW: PINNED }, 42)).toBe(pinnedMs);
  });

  it.each([
    { BROKER: "local-sim", ENVIRONMENT: "production" },
    { BROKER: "local-sim" },
    { BROKER: "tradestation", ENVIRONMENT: "test" },
    { ENVIRONMENT: "development" },
  ])("ignores TEST_NOW outside the local simulation: %j", (settings) => {
    expect(engineNow({ ...settings, TEST_NOW: PINNED }, 42)).toBe(42);
  });

  it("ignores a value that is not a date", () => {
    expect(engineNow({ BROKER: "local-sim", ENVIRONMENT: "test", TEST_NOW: "later" }, 42)).toBe(42);
  });
});

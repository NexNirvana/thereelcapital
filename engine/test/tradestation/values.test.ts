import { describe, expect, it } from "vitest";
import { averageMicrosOf, microsOf } from "../../src/tradestation/values.ts";
import { failureOf, run } from "./helpers.ts";

describe("averageMicrosOf", () => {
  it.each([
    ["0.5733333333", 573_333],
    ["0.5733336", 573_334],
    ["0.5733335", 573_334],
    ["0.5733334999", 573_333],
    ["-0.5733335", -573_334],
    ["212.87", 212_870_000],
    ["3", 3_000_000],
    ["0.9999995", 1_000_000],
  ])("rounds %s half away from zero to %d micros", async (raw, micros) => {
    expect(await run(averageMicrosOf("orders", "FilledPrice", raw))).toBe(micros);
  });

  it.each(["", "abc", "1.5x", "1e3", ".5", "1.", "--1", "9".repeat(20)])(
    "still refuses %j",
    async (raw) => {
      expect(await failureOf(averageMicrosOf("orders", "FilledPrice", raw))).toMatchObject({
        _tag: "Unknown",
        detail: "invalid_value:FilledPrice",
      });
    },
  );
});

describe("microsOf", () => {
  it("keeps refusing more than six decimals for prices we send or read as exact", async () => {
    expect(await failureOf(microsOf("quotes", "Bid", "0.5733333333"))).toMatchObject({
      detail: "invalid_value:Bid",
    });
  });
});

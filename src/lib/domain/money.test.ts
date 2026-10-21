import { describe, expect, test } from "bun:test";
import { formatUsd, parseMicros } from "./money";

describe("parseMicros", () => {
  test.each([
    ["0", 0], ["4.00", 4_000_000], ["20000", 20_000_000_000],
    ["0.000001", 1], ["1.234567", 1_234_567], ["0004.10", 4_100_000],
    ["9007199254.740991", Number.MAX_SAFE_INTEGER],
  ])("parses %s exactly", (decimal, expected) => {
    expect(parseMicros(decimal)).toBe(expected);
  });

  test.each([
    "", " ", " 4", "4 ", "4\n", "4\r\n", "4\t", "-1", "-0", "+1", ".5", "1.", "1e3", "0x10",
    "NaN", "Infinity", "1,000", "1.2.3", "1.0000000", "0.0000001",
    "9007199254.740992", "9999999999999999999999999999",
  ])("rejects invalid, overly precise or unsafe input %s", (decimal) => {
    expect(() => parseMicros(decimal)).toThrow(RangeError);
  });
});

describe("formatUsd", () => {
  test.each([
    [0, "$0.00"], [4_000_000, "$4.00"], [4_100_000, "$4.10"],
    [1, "$0.000001"], [1_234_567, "$1.234567"],
    [Number.MAX_SAFE_INTEGER, "$9007199254.740991"],
  ])("formats %s without losing precision", (micros, expected) => {
    expect(formatUsd(micros)).toBe(expected);
    expect(parseMicros(formatUsd(micros).slice(1))).toBe(micros);
  });

  test.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid micro-dollars %s", (micros) => {
      expect(() => formatUsd(micros)).toThrow(RangeError);
    },
  );
});

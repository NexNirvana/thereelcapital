import { describe, expect, test } from "bun:test";
import { parseMicros } from "./money";
import {
  appliedSize,
  choiceApplied,
  computeEntryQty,
  validateSizeChange,
  type EntryBlockReason,
  type EntrySizingInput,
} from "./sizing";

const option: EntrySizingInput = {
  size: parseMicros("20000"),
  ask: { status: "fresh", price: parseMicros("4.00") },
  pointValue: 100,
  increment: 1,
  minQty: 1,
  assetType: "option",
};

function expectQty(changes: Partial<EntrySizingInput>, qty: number): void {
  expect(computeEntryQty({ ...option, ...changes })).toEqual({ ok: true, qty });
}

describe("computeEntryQty", () => {
  test("SIZE 20,000 at ask 4.00 and point value 100 buys 50 contracts", () => {
    expectQty({}, 50);
  });

  test.each([
    [10, 500],
    [50, 100],
    [250, 20],
    [1000, 5],
  ])("uses the broker point value %s", (pointValue, qty) => {
    expectQty({ pointValue }, qty);
  });

  test("floors options to whole contracts, regardless of equity increment", () => {
    expectQty({ size: parseMicros("20399.999999"), increment: 10 }, 50);
  });

  test("does not round a micro-dollar shortfall up to another contract", () => {
    expectQty({ size: parseMicros("19999.999999") }, 49);
  });

  test("uses exact decimal prices", () => {
    expectQty(
      {
        size: parseMicros("0.30"),
        ask: { status: "fresh", price: parseMicros("0.10") },
        pointValue: 1,
      },
      3,
    );
  });

  test.each([
    [1, 100],
    [3, 99],
    [10, 100],
    [25, 100],
  ])("floors equity quantity to increment %s", (increment, qty) => {
    expectQty(
      { assetType: "equity", size: parseMicros("403.99"), pointValue: null, increment },
      qty,
    );
  });

  test("equities do not use an option point value", () => {
    expectQty({ assetType: "equity", increment: 30 }, 4980);
  });

  test("options need no equity increment", () => {
    expectQty({ increment: null }, 50);
  });

  const blocks: { changes: Partial<EntrySizingInput>; reason: EntryBlockReason }[] = [
    { changes: { ask: null }, reason: "QUOTE_MISSING" },
    { changes: { ask: { status: "fresh", price: 0 } }, reason: "QUOTE_MISSING" },
    { changes: { ask: { status: "stale" } }, reason: "QUOTE_STALE" },
    { changes: { ask: { status: "halted" } }, reason: "HALTED" },
    { changes: { pointValue: null }, reason: "SYMBOL_DETAILS_MISSING" },
    { changes: { minQty: null }, reason: "SYMBOL_DETAILS_MISSING" },
    { changes: { assetType: "equity", increment: null }, reason: "SYMBOL_DETAILS_MISSING" },
    { changes: { size: 0 }, reason: "BELOW_MINIMUM" },
    { changes: { size: parseMicros("399.99") }, reason: "BELOW_MINIMUM" },
    { changes: { minQty: 51 }, reason: "BELOW_MINIMUM" },
    {
      changes: { assetType: "equity", size: parseMicros("39.99"), increment: 10 },
      reason: "BELOW_MINIMUM",
    },
    { changes: { assetType: "equity", increment: 30, minQty: 4990 }, reason: "BELOW_MINIMUM" },
  ];
  test.each(blocks)("blocks with $reason for $changes", ({ changes, reason }) => {
    expect(computeEntryQty({ ...option, ...changes })).toEqual({ ok: false, reason });
  });

  test("accepts exactly the minimum quantity", () => {
    expectQty({ minQty: 50 }, 50);
    expectQty({ assetType: "equity", increment: 30, minQty: 4980 }, 4980);
  });

  test.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "blocks unusable broker details %s",
    (invalid) => {
      for (const changes of [
        { pointValue: invalid },
        { minQty: invalid },
        { assetType: "equity", increment: invalid } satisfies Partial<EntrySizingInput>,
      ]) {
        expect(computeEntryQty({ ...option, ...changes })).toEqual({
          ok: false,
          reason: "SYMBOL_DETAILS_MISSING",
        });
      }
    },
  );

  test("keeps products beyond the safe-integer range exact", () => {
    expectQty(
      { size: Number.MAX_SAFE_INTEGER, ask: { status: "fresh", price: 1 }, pointValue: 1 },
      Number.MAX_SAFE_INTEGER,
    );
    expect(
      computeEntryQty({
        ...option,
        size: Number.MAX_SAFE_INTEGER,
        ask: { status: "fresh", price: Number.MAX_SAFE_INTEGER },
        pointValue: 2,
      }),
    ).toEqual({ ok: false, reason: "BELOW_MINIMUM" });
    expect(
      computeEntryQty({
        ...option,
        assetType: "equity",
        size: Number.MAX_SAFE_INTEGER,
        increment: Number.MAX_SAFE_INTEGER,
      }),
    ).toEqual({ ok: false, reason: "BELOW_MINIMUM" });
  });

  test.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid money %s",
    (invalid) => {
      expect(() => computeEntryQty({ ...option, size: invalid })).toThrow(RangeError);
      expect(() =>
        computeEntryQty({ ...option, ask: { status: "fresh", price: invalid } }),
      ).toThrow(RangeError);
    },
  );
});

describe("validateSizeChange", () => {
  test("accepts only an increase, including a single micro-dollar", () => {
    const current = parseMicros("20000");
    expect(validateSizeChange(current, parseMicros("25000"))).toEqual({ ok: true });
    expect(validateSizeChange(current, parseMicros("20000.000001"))).toEqual({ ok: true });
    expect(validateSizeChange(current, current)).toEqual({
      ok: false,
      reason: "SIZE_NOT_INCREASED",
    });
    expect(validateSizeChange(current, parseMicros("19999.999999"))).toEqual({
      ok: false,
      reason: "SIZE_NOT_INCREASED",
    });
    expect(validateSizeChange(current, 0)).toEqual({ ok: false, reason: "SIZE_NOT_INCREASED" });
  });

  test.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid money %s",
    (invalid) => {
      expect(() => validateSizeChange(invalid, 1)).toThrow(RangeError);
      expect(() => validateSizeChange(1, invalid)).toThrow(RangeError);
    },
  );
});

describe("appliedSize", () => {
  test("the full choice keeps the SIZE", () => {
    expect(appliedSize(parseMicros("20000"), "full")).toBe(parseMicros("20000"));
  });

  test("down25 sizes 20,000 at 15,000", () => {
    expect(appliedSize(parseMicros("20000"), "down25")).toBe(parseMicros("15000"));
  });

  test("rounds a fraction of a micro-dollar down", () => {
    // 75% of 0.000005 is 0.00000375: three micro-dollars, not four.
    expect(appliedSize(5, "down25")).toBe(3);
  });

  test("rejects a SIZE that is not an integer number of micro-dollars", () => {
    expect(() => appliedSize(1.5, "down25")).toThrow();
  });

  test("an option: 15,000 at ask 4.00 and point value 100 buys 37 contracts, 50 at full SIZE", () => {
    const sizeFor = (choice: "full" | "down25") =>
      computeEntryQty({ ...option, size: appliedSize(option.size, choice) });
    expect(sizeFor("full")).toEqual({ ok: true, qty: 50 });
    expect(sizeFor("down25")).toEqual({ ok: true, qty: 37 });
  });

  test("a stock: 15,000 at ask 50.00 buys 300 shares, 400 at full SIZE", () => {
    const stock: EntrySizingInput = {
      ...option,
      assetType: "equity",
      pointValue: null,
      ask: { status: "fresh", price: parseMicros("50.00") },
    };
    expect(computeEntryQty({ ...stock, size: appliedSize(stock.size, "full") })).toEqual({
      ok: true,
      qty: 400,
    });
    expect(computeEntryQty({ ...stock, size: appliedSize(stock.size, "down25") })).toEqual({
      ok: true,
      qty: 300,
    });
  });
});

describe("choiceApplied", () => {
  test("matches the choice the engine echoes", () => {
    expect(choiceApplied("full", "full")).toBe(true);
    expect(choiceApplied("down25", "down25")).toBe(true);
    expect(choiceApplied("down25", "full")).toBe(false);
    expect(choiceApplied("full", "down25")).toBe(false);
  });

  test("an engine that echoes nothing applied the full SIZE, never a reduced one", () => {
    expect(choiceApplied("full", undefined)).toBe(true);
    expect(choiceApplied("down25", undefined)).toBe(false);
  });
});

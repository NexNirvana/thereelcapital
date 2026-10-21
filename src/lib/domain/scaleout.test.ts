import { describe, expect, test } from "bun:test";
import { availableQty } from "./position";
import { allOutQty, SCALE_OUT_STEPS, scaleOutQty, type ScaleOutStepState } from "./scaleout";

const examples = [
  { original: 1, quantities: [0, 1, 0, 0, 0, 0, 0] },
  { original: 7, quantities: [2, 2, 0, 1, 1, 0, 1] },
  { original: 37, quantities: [11, 8, 3, 4, 4, 3, 4] },
  { original: 50, quantities: [15, 10, 5, 5, 5, 5, 5] },
  { original: 80, quantities: [24, 16, 8, 8, 8, 8, 8] },
  { original: 137, quantities: [41, 28, 13, 14, 14, 13, 14] },
  { original: 200, quantities: [60, 40, 20, 20, 20, 20, 20] },
];

function permutations(indices: number[]): number[][] {
  return indices.length === 0
    ? [[]]
    : indices.flatMap((index) =>
        permutations(indices.filter((other) => other !== index)).map((rest) => [index, ...rest]),
      );
}

function pressSteps(originalQty: number, order: number[]): number[] {
  const position = { originalQty, soldQty: 0, committedQty: 0 };
  const steps: ScaleOutStepState[] = SCALE_OUT_STEPS.map(() => "available");
  return order.map((index) => {
    const before = [...steps];
    const result = scaleOutQty(position, steps, index);
    expect(steps).toEqual(before);
    if (result.kind === "rejected") throw new Error(result.reason);
    const qty = result.kind === "sell" ? result.qty : 0;
    expect(qty).toBeLessThanOrEqual(availableQty(position));
    steps[index] = result.kind === "sell" ? "done" : "done_zero";
    position.soldQty += qty;
    return qty;
  });
}

describe("domain-rules §6 worked table", () => {
  for (const { original, quantities } of examples) {
    test(`${original} original contracts`, () => {
      expect(pressSteps(original, [0, 1, 2, 3, 4, 5, 6])).toEqual(quantities);
    });

    test(`${original}: all 120 orders of the five 10% steps have the same cumulative totals`, () => {
      for (const order of permutations([2, 3, 4, 5, 6])) {
        const actual = pressSteps(original, [0, 1, ...order]);
        expect(
          actual.map((_, index) => actual.slice(0, index + 1).reduce((a, b) => a + b, 0)),
        ).toEqual(
          quantities.map((_, index) => quantities.slice(0, index + 1).reduce((a, b) => a + b, 0)),
        );
      }
    });
  }
});

test("pending steps count toward the target and pending quantities are subtracted", () => {
  const position = { originalQty: 37, soldQty: 5, committedQty: 6 };
  expect(scaleOutQty(position, ["pending", "available"], 1)).toEqual({ kind: "sell", qty: 8 });
});

test("all pending exits count in the ledger, including exits outside scale-out", () => {
  const position = { originalQty: 50, soldQty: 4, committedQty: 10 };
  expect(scaleOutQty(position, ["available"], 0)).toEqual({ kind: "sell", qty: 1 });
});

test("done_zero counts toward cumulative percentage without recording a sale", () => {
  const position = { originalQty: 1, soldQty: 0, committedQty: 0 };
  expect(scaleOutQty(position, ["available", "available"], 0)).toEqual({ kind: "done_zero" });
  expect(scaleOutQty(position, ["done_zero", "available"], 1)).toEqual({ kind: "sell", qty: 1 });
  expect(position.soldQty).toBe(0);
});

test("targets already sold or committed yield done_zero with no quantity", () => {
  expect(scaleOutQty({ originalQty: 50, soldQty: 10, committedQty: 10 }, ["available"], 0)).toEqual(
    { kind: "done_zero" },
  );
});

test("scale-out and ALL OUT never exceed available, even after overcommitment", () => {
  for (let soldQty = 0; soldQty <= 8; soldQty++) {
    for (let committedQty = 0; committedQty <= 8; committedQty++) {
      const position = { originalQty: 7, soldQty, committedQty };
      const result = scaleOutQty(position, ["available"], 0);
      expect(result.kind).not.toBe("rejected");
      if (result.kind === "sell") {
        expect(result.qty).toBeGreaterThan(0);
        expect(result.qty).toBeLessThanOrEqual(availableQty(position));
      }
      expect(allOutQty(position)).toBe(availableQty(position));
    }
  }
});

test("rejects every unavailable step state", () => {
  for (const state of ["pending", "done", "done_zero"] satisfies ScaleOutStepState[]) {
    expect(scaleOutQty({ originalQty: 50, soldQty: 0, committedQty: 0 }, [state], 0)).toEqual({
      kind: "rejected",
      reason: "STEP_NOT_AVAILABLE",
    });
  }
});

test("rejects out-of-range and non-integer indices", () => {
  for (const index of [-1, 7, 0.5, NaN, Infinity]) {
    expect(scaleOutQty({ originalQty: 50, soldQty: 0, committedQty: 0 }, [], index)).toEqual({
      kind: "rejected",
      reason: "STEP_INDEX_OUT_OF_RANGE",
    });
  }
});

test("equities round cumulative targets half-up to the broker increment", () => {
  expect(
    scaleOutQty({ originalQty: 50, soldQty: 0, committedQty: 0 }, ["available"], 0, 10),
  ).toEqual({ kind: "sell", qty: 20 });
  expect(
    scaleOutQty({ originalQty: 50, soldQty: 20, committedQty: 0 }, ["done", "available"], 1, 10),
  ).toEqual({ kind: "sell", qty: 10 });
  expect(
    scaleOutQty({ originalQty: 37, soldQty: 0, committedQty: 0 }, ["available"], 0, 5),
  ).toEqual({ kind: "sell", qty: 10 });
});

test("equity quantities respect increment after subtracting partial fills and clamping", () => {
  expect(
    scaleOutQty({ originalQty: 50, soldQty: 1, committedQty: 1 }, ["available"], 0, 10),
  ).toEqual({ kind: "sell", qty: 10 });
  expect(
    scaleOutQty({ originalQty: 7, soldQty: 0, committedQty: 0 }, ["available"], 0, 10),
  ).toEqual({ kind: "done_zero" });
  expect(
    scaleOutQty(
      { originalQty: 37, soldQty: 30, committedQty: 0 },
      ["done", "done", "done", "done", "done", "done", "available"],
      6,
      5,
    ),
  ).toEqual({ kind: "sell", qty: 5 });
});

test("rejects invalid integer increments as programmer errors", () => {
  for (const increment of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() =>
      scaleOutQty({ originalQty: 50, soldQty: 0, committedQty: 0 }, ["available"], 0, increment),
    ).toThrow(RangeError);
  }
});

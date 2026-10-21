import { expect, test } from "bun:test";
import { availableQty } from "./position";

test("available excludes confirmed sold and pending exit quantities", () => {
  expect(availableQty({ originalQty: 50, soldQty: 15, committedQty: 10 })).toBe(25);
});

test("available is zero for an empty, fully sold or overcommitted position", () => {
  for (const position of [
    { originalQty: 0, soldQty: 0, committedQty: 0 },
    { originalQty: 7, soldQty: 7, committedQty: 0 },
    { originalQty: 7, soldQty: 5, committedQty: 4 },
  ]) {
    expect(availableQty(position)).toBe(0);
  }
});

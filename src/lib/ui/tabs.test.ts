import { expect, test } from "bun:test";
import { tabForKey } from "./tabs";

const ids = ["a", "b", "c"];

test("arrows move with wrap-around", () => {
  expect(tabForKey(ids, "a", "ArrowRight")).toBe("b");
  expect(tabForKey(ids, "c", "ArrowRight")).toBe("a");
  expect(tabForKey(ids, "b", "ArrowLeft")).toBe("a");
  expect(tabForKey(ids, "a", "ArrowLeft")).toBe("c");
});

test("Home and End jump to the ends", () => {
  expect(tabForKey(ids, "b", "Home")).toBe("a");
  expect(tabForKey(ids, "b", "End")).toBe("c");
});

test("other keys are ignored", () => {
  expect(tabForKey(ids, "a", "Enter")).toBeUndefined();
});

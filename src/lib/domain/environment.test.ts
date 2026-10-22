import { expect, test } from "bun:test";
import { allowsTestAffordances } from "./environment.ts";

test("only development and test allow test affordances", () => {
  expect(allowsTestAffordances("test")).toBe(true);
  expect(allowsTestAffordances("development")).toBe(true);
  for (const other of [undefined, "", "production", "Test", "staging"]) {
    expect(allowsTestAffordances(other)).toBe(false);
  }
});

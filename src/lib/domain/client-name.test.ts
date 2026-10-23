import { describe, expect, test } from "bun:test";
import { CLIENT_NAME_MAX_CHARS, normalizeClientName } from "./client-name.ts";

describe("normalizeClientName", () => {
  test("trims surrounding whitespace", () => {
    expect(normalizeClientName("  Ana Pérez \n")).toBe("Ana Pérez");
  });

  test("rejects an empty or blank name", () => {
    expect(normalizeClientName("")).toBeNull();
    expect(normalizeClientName(" \t ")).toBeNull();
  });

  test("accepts exactly the maximum length and rejects one more", () => {
    expect(normalizeClientName("a".repeat(CLIENT_NAME_MAX_CHARS))).not.toBeNull();
    expect(normalizeClientName("a".repeat(CLIENT_NAME_MAX_CHARS + 1))).toBeNull();
  });

  test("rejects control characters inside the name", () => {
    expect(normalizeClientName("Ana\nPérez")).toBeNull();
    expect(normalizeClientName("Ana\u0000")).toBeNull();
  });
});

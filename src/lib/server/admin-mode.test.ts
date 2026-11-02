import { describe, expect, test } from "bun:test";
import { adminModeOf } from "./admin-mode.ts";

const mode = (query: string) =>
  adminModeOf(new URL(`https://example.test/admin/operativa${query}`));

describe("adminModeOf", () => {
  test("defaults to SIM", () => {
    expect(mode("")).toBe("SIM");
    expect(mode("?otro=1")).toBe("SIM");
  });

  test("accepts SIM and REAL", () => {
    expect(mode("?modo=SIM")).toBe("SIM");
    expect(mode("?modo=REAL")).toBe("REAL");
  });

  test("rejects any other value with a 400", () => {
    for (const value of ["real", "", "LIVE", "SIM,REAL"]) {
      expect(() => mode(`?modo=${value}`)).toThrow();
    }
  });
});

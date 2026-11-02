import { describe, expect, test } from "bun:test";
import type { AllowedModes } from "#lib/domain/modes.ts";
import { formModeMatches, modeFor, resolveMode, revalidatedMode } from "./trading-mode.ts";

const both: AllowedModes = { entries: ["SIM", "REAL"], exits: ["SIM", "REAL"] };
const exitsOnly: AllowedModes = { entries: ["SIM"], exits: ["SIM", "REAL"] };
const simOnly: AllowedModes = { entries: ["SIM"], exits: ["SIM"] };

describe("resolveMode", () => {
  test("keeps REAL when the engine lists it for entries and exits", () => {
    expect(resolveMode("REAL", both)).toBe("REAL");
  });

  test("keeps REAL when only exits are allowed", () => {
    expect(resolveMode("REAL", exitsOnly)).toBe("REAL");
  });

  test("falls back to SIM when REAL is no longer listed", () => {
    expect(resolveMode("REAL", simOnly)).toBe("SIM");
  });

  test("falls back to SIM when the modes are unknown", () => {
    expect(resolveMode("REAL", null)).toBe("SIM");
  });

  test.each([undefined, null, "", "sim", "real", "SIM", "REAL ", 1])(
    "ignores the cookie value %p unless it is exactly REAL",
    (value) => {
      expect(resolveMode(value, both)).toBe("SIM");
    },
  );
});

describe("revalidatedMode", () => {
  test("asks the engine only when REAL was requested", async () => {
    let calls = 0;
    const read = async () => {
      calls += 1;
      return { ok: true as const, value: both };
    };
    expect(await revalidatedMode(undefined, read)).toBe("SIM");
    expect(await revalidatedMode("SIM", read)).toBe("SIM");
    expect(calls).toBe(0);
    expect(await revalidatedMode("REAL", read)).toBe("REAL");
    expect(calls).toBe(1);
  });

  test("falls back to SIM when the engine refuses or throws", async () => {
    expect(await revalidatedMode("REAL", async () => ({ ok: false as const }))).toBe("SIM");
    expect(
      await revalidatedMode("REAL", async () => {
        throw new Error("engine down");
      }),
    ).toBe("SIM");
  });

  test("falls back to SIM when the client lost REAL", async () => {
    expect(await revalidatedMode("REAL", async () => ({ ok: true as const, value: simOnly }))).toBe(
      "SIM",
    );
  });
});

describe("formModeMatches", () => {
  const form = (modo?: string) => {
    const data = new FormData();
    if (modo !== undefined) data.set("modo", modo);
    return data;
  };

  test("accepts the revalidated mode only", () => {
    expect(formModeMatches(form("REAL"), "REAL")).toBe(true);
    expect(formModeMatches(form("SIM"), "SIM")).toBe(true);
    expect(formModeMatches(form("SIM"), "REAL")).toBe(false);
    expect(formModeMatches(form("REAL"), "SIM")).toBe(false);
  });

  test("refuses a form without a mode", () => {
    expect(formModeMatches(form(), "SIM")).toBe(false);
  });
});

describe("modeFor", () => {
  test("is the mode the hook revalidated", () => {
    expect(modeFor({ locals: { mode: "REAL" } })).toBe("REAL");
  });
});

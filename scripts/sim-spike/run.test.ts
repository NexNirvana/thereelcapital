import { describe, expect, test } from "bun:test";
import { parseArgs } from "./run.ts";
import { ORDER_STEPS, STEPS } from "./steps.ts";

describe("parseArgs", () => {
  test("runs every step by default and none of them places orders without the flag", () => {
    const options = parseArgs([]);
    if (typeof options === "string") throw new Error(options);
    expect(options.steps).toEqual(STEPS.map(([name]) => name));
    expect(options.confirmSimOrders).toBe(false);
  });

  test("runs one step alone and reads the options", () => {
    const options = parseArgs(["stops", "--confirm-sim-orders", "--port", "3001", "--symbol", "f"]);
    expect(options).toMatchObject({
      steps: ["stops"],
      confirmSimOrders: true,
      port: 3001,
      symbol: "F",
    });
  });

  test("reads --paste and leaves it off by default", () => {
    expect(parseArgs(["--paste"])).toMatchObject({ paste: true });
    expect(parseArgs([])).toMatchObject({ paste: false });
  });

  test("rejects unknown steps and options", () => {
    expect(typeof parseArgs(["nope"])).toBe("string");
    expect(typeof parseArgs(["--live"])).toBe("string");
    expect(typeof parseArgs(["--port", "99999"])).toBe("string");
  });

  test("order steps are known steps", () => {
    const names = STEPS.map(([name]) => name);
    for (const name of ORDER_STEPS) expect(names).toContain(name);
  });
});

import { describe, expect, it } from "vitest";
import { activeModes } from "../src/mode.ts";

describe("activeModes", () => {
  it("serves SIM only until REAL mode is built", () => {
    expect(activeModes()).toEqual(["SIM"]);
  });
});

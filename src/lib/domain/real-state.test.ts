import { describe, expect, test } from "bun:test";
import { allowedModes } from "./modes.ts";
import { realStateOf } from "./real-state.ts";

const state = (deploymentOpen: boolean, clientEnabled: boolean, hasOpenReal: boolean) =>
  realStateOf(clientEnabled, allowedModes({ deploymentOpen, clientEnabled, hasOpenReal }));

describe("realStateOf", () => {
  test("is active with the deployment open and the switch on", () => {
    expect(state(true, true, false)).toBe("active");
    expect(state(true, true, true)).toBe("active");
  });

  test("allows only exits with the switch off and REAL positions open", () => {
    expect(state(true, false, true)).toBe("exits-only");
  });

  test("is closed when the switch is on but the deployment is closed", () => {
    expect(state(false, true, false)).toBe("closed");
    expect(state(false, true, true)).toBe("closed");
  });

  test("is off with the switch off and nothing open", () => {
    expect(state(true, false, false)).toBe("off");
    expect(state(false, false, false)).toBe("off");
  });

  test("cannot tell a closed deployment from an idle switch when the flag is off", () => {
    // Open REAL positions with the deployment closed look like "off": the engine reports SIM only.
    expect(state(false, false, true)).toBe("off");
  });
});

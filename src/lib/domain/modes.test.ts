import { describe, expect, test } from "bun:test";
import { allowedModes, type Mode } from "./modes.ts";

const SIM: Mode[] = ["SIM"];
const BOTH: Mode[] = ["SIM", "REAL"];

// deploymentOpen, clientEnabled, hasOpenReal -> entries, exits (all 8 combinations)
const table = [
  [false, false, false, SIM, SIM],
  [false, false, true, SIM, SIM],
  [false, true, false, SIM, SIM],
  [false, true, true, SIM, SIM],
  [true, false, false, SIM, SIM],
  [true, false, true, SIM, BOTH],
  [true, true, false, BOTH, BOTH],
  [true, true, true, BOTH, BOTH],
] as const;

describe("allowedModes", () => {
  test.each(table)(
    "deployment %p, client %p, open REAL %p gives entries %p and exits %p",
    (deploymentOpen, clientEnabled, hasOpenReal, entries, exits) => {
      expect(allowedModes({ deploymentOpen, clientEnabled, hasOpenReal })).toEqual({
        entries,
        exits,
      });
    },
  );

  test("keeps REAL out of every list while the deployment is closed, whatever the client has", () => {
    for (const clientEnabled of [false, true]) {
      for (const hasOpenReal of [false, true]) {
        const modes = allowedModes({ deploymentOpen: false, clientEnabled, hasOpenReal });
        expect([...modes.entries, ...modes.exits]).not.toContain("REAL");
      }
    }
  });

  test("lets a client with the switch off exit an open REAL position but not enter", () => {
    const modes = allowedModes({ deploymentOpen: true, clientEnabled: false, hasOpenReal: true });
    expect(modes.entries).not.toContain("REAL");
    expect(modes.exits).toContain("REAL");
  });

  test("always allows SIM for entries and exits", () => {
    for (const deploymentOpen of [false, true]) {
      for (const clientEnabled of [false, true]) {
        for (const hasOpenReal of [false, true]) {
          const modes = allowedModes({ deploymentOpen, clientEnabled, hasOpenReal });
          expect(modes.entries).toContain("SIM");
          expect(modes.exits).toContain("SIM");
        }
      }
    }
  });
});

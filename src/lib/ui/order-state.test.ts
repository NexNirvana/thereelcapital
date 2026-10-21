import { describe, expect, test } from "bun:test";
import { isTerminal, stateCopy } from "./order-state.ts";

const intent = (state: string, filledQty = 0) => ({ state, qty: 198, filledQty });

describe("stateCopy", () => {
  test("says «Ejecutada» only for a filled order", () => {
    for (const state of ["ARMED", "SENT", "ACKNOWLEDGED", "PARTIAL", "REJECTED", "UNKNOWN"]) {
      expect(stateCopy(intent(state, 50)).label).not.toBe("Ejecutada");
      expect(stateCopy(intent(state, 50)).detail).not.toContain("Ejecutada");
    }
    expect(stateCopy(intent("FILLED", 198)).label).toBe("Ejecutada");
  });

  test("gives each state a distinct label", () => {
    const states = ["SENT", "ACKNOWLEDGED", "PARTIAL", "FILLED", "REJECTED", "UNKNOWN"];
    const labels = states.map((state) => stateCopy(intent(state)).label);
    expect(new Set(labels).size).toBe(states.length);
  });

  test("explains UNKNOWN as being verified, not as a failure", () => {
    const { label, detail } = stateCopy(intent("UNKNOWN"));
    expect(label).toBe("Verificando");
    expect(detail).toContain("no es un fallo");
  });

  test("reports the filled part of a partial fill", () => {
    expect(stateCopy(intent("PARTIAL", 50)).detail).toContain("50 de 198");
  });
});

describe("isTerminal", () => {
  test("stops on FILLED, REJECTED and CANCELED but not on UNKNOWN or PARTIAL", () => {
    expect(["FILLED", "REJECTED", "CANCELED"].every(isTerminal)).toBe(true);
    expect(["SENT", "ACKNOWLEDGED", "PARTIAL", "UNKNOWN"].some(isTerminal)).toBe(false);
  });
});

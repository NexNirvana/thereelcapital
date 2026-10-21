import { describe, expect, it } from "bun:test";
import { blockMessage, formatPrice, formatQuantity, formatSize, limitsLine } from "./new-entry.ts";

describe("blockMessage", () => {
  it("words the first reason in Spanish", () => {
    expect(blockMessage(["OUTSIDE_REGULAR_SESSION", "DAILY_ENTRY_LIMIT"])).toBe(
      "El mercado está cerrado. Solo operas en la sesión regular.",
    );
  });

  it("explains a connection with no tradable account", () => {
    expect(blockMessage(["NO_ACCOUNT"])).toContain("cuenta");
  });

  it("falls back to a generic line for a code it does not know", () => {
    expect(blockMessage(["SOMETHING_NEW"])).toBe("No podemos preparar esta entrada ahora.");
    expect(blockMessage([])).toBe("No podemos preparar esta entrada ahora.");
  });
});

describe("limitsLine", () => {
  it("reads like the design", () => {
    expect(limitsLine({ positions: 1, maxPositions: 2, entriesToday: 2, maxEntries: 3 })).toBe(
      "1/2 posiciones · 2/3 entradas hoy",
    );
  });
});

describe("money and quantity", () => {
  it("formats the SIZE in whole dollars and the ask with cents", () => {
    expect(formatSize(20_000_000_000)).toBe("US$20,000");
    expect(formatPrice(4_000_000)).toBe("US$4.00");
    expect(formatPrice(101_250_000)).toBe("US$101.25");
    // No micro-dollar is lost, and a SIZE with cents keeps them.
    expect(formatPrice(1_234_567)).toBe("US$1.234567");
    expect(formatSize(20_000_500_000)).toBe("US$20,000.50");
    expect(formatPrice(1_250_000_000)).toBe("US$1,250.00");
  });

  it("pluralizes by instrument", () => {
    expect(formatQuantity(50, "option")).toBe("50 contratos");
    expect(formatQuantity(1, "option")).toBe("1 contrato");
    expect(formatQuantity(198, "equity")).toBe("198 acciones");
    expect(formatQuantity(1, "equity")).toBe("1 acción");
  });
});

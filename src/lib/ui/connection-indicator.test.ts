import { describe, expect, it } from "bun:test";
import { indicatorFor } from "./connection-indicator";

describe("indicatorFor", () => {
  it("shows a healthy connection without an action", () => {
    expect(indicatorFor({ status: "ok" })).toEqual({
      state: "Conectado",
      label: "TradeStation conectado",
      healthy: true,
      action: null,
    });
  });

  it("warns ahead of expiry and offers to reconnect", () => {
    const shown = indicatorFor({ status: "expiring", refreshExpiresAt: 1 });
    expect(shown.label).toBe("TradeStation vence pronto");
    expect(shown.action).toBe("Reconectar con TradeStation");
  });

  it("offers to reconnect when expired, revoked or in error", () => {
    for (const status of ["expired", "revoked", "error"] as const) {
      const shown = indicatorFor({ status });
      expect(shown.healthy).toBe(false);
      expect(shown.action).toBe("Reconectar con TradeStation");
    }
  });

  it("offers to connect when there is no connection, and says nothing when unreadable", () => {
    expect(indicatorFor(null).action).toBe("Conectar con TradeStation");
    expect(indicatorFor(undefined)).toMatchObject({ label: "TradeStation —", action: null });
  });
});

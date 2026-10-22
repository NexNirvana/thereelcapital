import { describe, expect, test } from "bun:test";
import type { ConnectionHealth } from "#lib/domain/connection.ts";
import { connectionKey, type ClientOverview } from "#lib/domain/overview.ts";
import { connectionLabel, openQty, protectionLabel } from "./admin-operations.ts";

const base = {
  positionsOpen: 0,
  maxPositions: 2,
  entriesToday: 0,
  maxEntries: 3,
  positions: [],
  orders: [],
} as const;
const connected = (health: ConnectionHealth): ClientOverview => ({
  ...base,
  connection: {
    status: "CONNECTED",
    health,
    entriesBlocked: false,
    accounts: [],
    refreshExpiresAt: null,
    lastOkAt: null,
  },
});

describe("connectionKey", () => {
  test("maps every engine answer to one key", () => {
    const ok = (value: ClientOverview) => ({ status: "ok" as const, value });
    expect(connectionKey(null)).toBe("NOT_CONNECTED");
    expect(connectionKey({ status: "unavailable" })).toBe("UNAVAILABLE");
    expect(connectionKey(ok({ ...base, connection: { status: "NOT_CONNECTED" } }))).toBe(
      "NOT_CONNECTED",
    );
    for (const status of ["ok", "expired", "revoked", "error"] as const) {
      expect(connectionKey(ok(connected({ status })))).toBe(status);
    }
    expect(connectionKey(ok(connected({ status: "expiring", refreshExpiresAt: 1 })))).toBe(
      "expiring",
    );
  });
});

describe("labels", () => {
  test("words each connection key in Spanish", () => {
    expect(
      (
        ["NOT_CONNECTED", "UNAVAILABLE", "ok", "expiring", "expired", "revoked", "error"] as const
      ).map(connectionLabel),
    ).toEqual([
      "Sin conectar",
      "No disponible",
      "Conectado",
      "Vence pronto",
      "Venció",
      "Sin acceso",
      "Sin respuesta",
    ]);
  });

  test("words protection and the open quantity", () => {
    expect(protectionLabel("unverified")).toBe("No verificado");
    expect(protectionLabel("none")).toBe("Sin activar");
    expect(protectionLabel("verified")).toBe("Activo");
    expect(protectionLabel("legacy")).toBe("No verificado");
    expect(openQty({ originalQty: 100, soldQty: 30 })).toBe(70);
  });
});

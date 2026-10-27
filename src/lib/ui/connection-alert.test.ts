import { describe, expect, it } from "bun:test";
import type { ShellConnection } from "#lib/server/shell-connection.ts";
import type { ConnectionHealth } from "#lib/domain/connection.ts";
import { connectionAlert, unverifiedLine, unverifiedSince } from "./connection-alert.ts";

const connected = (
  health: ConnectionHealth,
  lastSyncAt: number | null = null,
  entriesBlocked = false,
): ShellConnection => ({
  ok: true,
  view: {
    status: "CONNECTED",
    health,
    entriesBlocked,
    accounts: [],
    refreshExpiresAt: null,
    lastSyncAt,
  },
});
const LAST_OK = Date.parse("2026-10-27T12:10:00Z");

describe("connectionAlert", () => {
  it("is silent while the connection works, even when it expires soon", () => {
    expect(connectionAlert(connected({ status: "ok" }))).toBeNull();
    expect(connectionAlert(connected({ status: "expiring", refreshExpiresAt: 1 }))).toBeNull();
  });

  it("is silent when the engine could not be read: the top bar already says unknown", () => {
    expect(connectionAlert(null)).toBeNull();
    expect(connectionAlert({ ok: false, message: "x" })).toBeNull();
  });

  it("asks a client who never connected to connect", () => {
    expect(connectionAlert({ ok: true, view: { status: "NOT_CONNECTED" } })).toMatchObject({
      kind: "never",
      title: "Conecta tu cuenta de TradeStation para operar",
      action: "Conectar con TradeStation",
      since: null,
    });
  });

  it("warns when the token is fine but no pass has confirmed the state", () => {
    const alert = connectionAlert(connected({ status: "ok" }, LAST_OK, true));
    expect(alert).toMatchObject({ kind: "pending", since: LAST_OK });
    expect(alert?.lines[1]).toBe("Última sincronización correcta: 27 oct 2026, 8:10 ET.");
  });

  it("tells a lost connection apart, with the last good sync and what cannot be done", () => {
    const alert = connectionAlert(connected({ status: "revoked" }, LAST_OK));
    expect(alert).toMatchObject({
      kind: "lost",
      title: "La conexión con TradeStation no está activa",
      action: "Reconectar con TradeStation",
      since: LAST_OK,
    });
    expect(alert?.lines).toEqual([
      "TradeStation rechazó o cerró la conexión.",
      "Última sincronización correcta: 27 oct 2026, 8:10 ET.",
      "No podemos verificar tus posiciones, precios ni órdenes, ni enviar nuevas, hasta que reconectes.",
    ]);
  });

  it("words each cause, and leaves out the time when it is unknown", () => {
    const expired = connectionAlert(connected({ status: "expired" }));
    expect(expired?.lines[0]).toBe("La conexión con TradeStation venció.");
    expect(expired?.lines).toHaveLength(2);
    expect(connectionAlert(connected({ status: "error" }))?.lines[0]).toBe(
      "No pudimos renovar la conexión con TradeStation.",
    );
  });
});

describe("unverified wording", () => {
  it("names the last good sync when there is one", () => {
    expect(unverifiedLine(LAST_OK)).toBe("Datos sin verificar desde 27 oct 2026, 8:10 ET");
    expect(unverifiedLine(null)).toBe("Datos sin verificar");
  });

  it("is undefined while the connection works", () => {
    expect(unverifiedSince(connected({ status: "ok" }))).toBeUndefined();
    expect(unverifiedSince(connected({ status: "revoked" }, LAST_OK))).toBe(LAST_OK);
    expect(unverifiedSince({ ok: true, view: { status: "NOT_CONNECTED" } })).toBeNull();
  });
});

describe("an engine view without lastSyncAt (previous engine code)", () => {
  const old = (health: ConnectionHealth, entriesBlocked: boolean): ShellConnection => ({
    ok: true,
    view: {
      status: "CONNECTED",
      health,
      entriesBlocked,
      accounts: [],
      refreshExpiresAt: null,
      // @ts-expect-error the old engine omits the field; the type says null
      lastSyncAt: undefined,
    },
  });

  it("still builds the pending and lost alerts, without a time", () => {
    const pending = connectionAlert(old({ status: "ok" }, true));
    expect(pending).toMatchObject({ kind: "pending", since: null });
    expect(pending?.lines.join(" ")).not.toContain("Última sincronización");
    expect(connectionAlert(old({ status: "revoked" }, true))).toMatchObject({
      kind: "lost",
      since: null,
    });
  });

  it("words the unverified line without a time", () => {
    expect(unverifiedLine(undefined as unknown as null)).toBe("Datos sin verificar");
    expect(unverifiedLine(Number.NaN)).toBe("Datos sin verificar");
  });
});

import { describe, expect, it } from "bun:test";
import {
  eventLabel,
  eventText,
  fillLine,
  fillPrice,
  formatWhen,
  kindLabel,
  sizeLine,
  stateLabel,
} from "./history.ts";

describe("history wording", () => {
  it("labels every order state of the lifecycle", () => {
    const states = [
      "ARMED",
      "SENT",
      "ACKNOWLEDGED",
      "PARTIAL",
      "FILLED",
      "CANCEL_PENDING",
      "CANCELED",
      "REJECTED",
      "UNKNOWN",
    ];
    for (const state of states) expect(stateLabel(state)).not.toBe("Desconocida");
    expect(stateLabel("WAT")).toBe("Desconocida");
    expect(kindLabel("entry")).toBe("Entrada");
  });

  it("does not expose an internal event code", () => {
    expect(eventLabel("broker.connected")).toBe("TradeStation conectado");
    expect(eventLabel("rpc.invalid_input")).toBe("Evento del sistema");
  });

  it("words the expiration-day close events", () => {
    expect(eventLabel("protection.expiry_triggered")).toBe("Cierre por vencimiento");
    expect(eventLabel("protection.expiry_close_skipped")).not.toBe("Evento del sistema");
  });

  it("does not call a connection TradeStation rejected expired", () => {
    expect(eventLabel("sync.token_expired")).toContain("rechazó o cerró");
    expect(eventLabel("sync.token_expired")).not.toContain("vencida");
  });

  it("shows market time with daylight saving", () => {
    expect(formatWhen(Date.parse("2026-11-04T15:00:00Z"))).toBe("4 nov 2026, 10:00 ET");
    expect(formatWhen(Date.parse("2026-07-01T15:00:00Z"))).toBe("1 jul 2026, 11:00 ET");
  });

  it("shows fills and a dash before the first one", () => {
    expect(fillLine(10, 50)).toBe("10/50");
    expect(fillPrice(null)).toBe("—");
    expect(fillPrice(101_000_000)).toBe("US$101.00");
  });
});

describe("event wording with the failing operation", () => {
  it("names the read and the reason of a sync failure", () => {
    expect(
      eventText({ type: "sync.broker_error", operation: "orders", detail: "invalid_response" }),
    ).toBe("Error al sincronizar con TradeStation (órdenes: respuesta no válida)");
    expect(
      eventText({
        type: "sync.broker_error",
        operation: "positions",
        detail: "invalid_value:Quantity",
      }),
    ).toContain("posiciones: ");
  });

  it("leaves other events as their label", () => {
    expect(eventText({ type: "broker.connected", operation: null, detail: null })).toBe(
      eventLabel("broker.connected"),
    );
  });
});

describe("sizeLine", () => {
  it("shows a dash for rows from an engine that predates the fields", () => {
    expect(sizeLine({ kind: "entry" })).toBe("—");
  });

  it("shows the SIZE an entry used and marks the −25% choice", () => {
    expect(sizeLine({ kind: "entry", size_applied: 20_000_000_000, size_choice: "full" })).toBe(
      "US$20,000",
    );
    expect(sizeLine({ kind: "entry", size_applied: 15_000_000_000, size_choice: "down25" })).toBe(
      "US$15,000 · −25%",
    );
  });

  it("is a dash for exits and for entries with no recorded SIZE", () => {
    expect(sizeLine({ kind: "exit", size_applied: null, size_choice: null })).toBe("—");
    expect(sizeLine({ kind: "entry", size_applied: null, size_choice: null })).toBe("—");
  });

  it("treats an entry from before the choice existed as the full SIZE", () => {
    expect(sizeLine({ kind: "entry", size_applied: 20_000_000_000, size_choice: null })).toBe(
      "US$20,000",
    );
  });
});

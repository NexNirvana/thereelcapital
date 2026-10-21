import { describe, expect, it } from "bun:test";
import { REFRESH_EXPIRY_WARNING_MS } from "./config";
import { connectionHealth, entryBlock } from "./connection";

const NOW = 1_000_000_000_000;

describe("connectionHealth", () => {
  it("is ok when the expiry is unknown", () => {
    expect(connectionHealth({ stored: "CONNECTED", refreshExpiresAt: null, now: NOW })).toEqual({
      status: "ok",
    });
  });

  it("is ok while the known expiry is further away than the warning window", () => {
    const refreshExpiresAt = NOW + REFRESH_EXPIRY_WARNING_MS + 1;
    expect(connectionHealth({ stored: "CONNECTED", refreshExpiresAt, now: NOW }).status).toBe("ok");
  });

  it("is expiring at the edge of the warning window", () => {
    const refreshExpiresAt = NOW + REFRESH_EXPIRY_WARNING_MS;
    expect(connectionHealth({ stored: "CONNECTED", refreshExpiresAt, now: NOW })).toEqual({
      status: "expiring",
      refreshExpiresAt,
    });
  });

  it("is expired once the known expiry has passed, exactly at it included", () => {
    expect(connectionHealth({ stored: "CONNECTED", refreshExpiresAt: NOW, now: NOW }).status).toBe(
      "expired",
    );
  });

  it("maps every recorded failure, whatever the expiry says", () => {
    const far = NOW + 10 * REFRESH_EXPIRY_WARNING_MS;
    expect(connectionHealth({ stored: "EXPIRED", refreshExpiresAt: far, now: NOW }).status).toBe(
      "expired",
    );
    expect(connectionHealth({ stored: "REVOKED", refreshExpiresAt: null, now: NOW }).status).toBe(
      "revoked",
    );
    expect(connectionHealth({ stored: "ERROR", refreshExpiresAt: null, now: NOW }).status).toBe(
      "error",
    );
  });
});

describe("entryBlock", () => {
  const ok = { status: "ok" } as const;
  const expiring = { status: "expiring", refreshExpiresAt: NOW } as const;

  it("allows entries when healthy and reconciled, also while expiring", () => {
    expect(entryBlock({ health: ok, reconciliationPending: false })).toBeNull();
    expect(entryBlock({ health: expiring, reconciliationPending: false })).toBeNull();
  });

  it("blocks entries for expired, revoked and error", () => {
    for (const status of ["expired", "revoked", "error"] as const) {
      expect(entryBlock({ health: { status }, reconciliationPending: false })).toBe(
        "CONNECTION_UNUSABLE",
      );
    }
  });

  it("keeps entries blocked after reconnecting until reconciliation is done", () => {
    expect(entryBlock({ health: ok, reconciliationPending: true })).toBe("RECONCILIATION_PENDING");
  });
});

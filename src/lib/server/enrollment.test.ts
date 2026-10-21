import { describe, expect, test } from "bun:test";
import { enrollmentGate, enrollmentMaxAgeMs } from "./enrollment.ts";

const now = new Date("2026-10-21T15:00:00Z");
const live = { enrollment: true, createdAt: new Date(now.getTime() - 60_000) };
const stale = { enrollment: true, createdAt: new Date(now.getTime() - enrollmentMaxAgeMs - 1) };

describe("enrollment gate", () => {
  test("ignores full sessions and signed-out requests", () => {
    expect(enrollmentGate(null, "/", now)).toEqual({ kind: "none" });
    expect(enrollmentGate({ enrollment: false, createdAt: now }, "/", now)).toEqual({
      kind: "none",
    });
  });

  test("lets a live enrollment session register a passkey and finish", () => {
    for (const path of [
      "/acceso",
      "/recuperacion",
      "/api/auth/passkey/generate-register-options",
      "/api/auth/passkey/verify-registration",
      "/api/auth/enrollment/complete",
      "/api/auth/get-session",
      "/_app/immutable/x.js",
    ]) {
      expect(enrollmentGate(live, path, now)).toMatchObject({ allowed: true, expired: false });
    }
  });

  test("closes everything else to it, including Better Auth endpoints", () => {
    for (const path of [
      "/",
      "/api/recovery-codes",
      "/api/auth/passkey/list-user-passkeys",
      "/api/auth/passkey/delete-passkey",
      "/api/auth/admin/list-users",
      "/api/auth/revoke-sessions",
      "/api/auth/update-user",
      "/api/auth/recovery/redeem/../passkey/list-user-passkeys",
    ]) {
      expect(enrollmentGate(live, path, now)).toMatchObject({ allowed: false });
    }
  });

  test("measures the lifetime from creation, not from the refreshable expiry", () => {
    expect(enrollmentGate(stale, "/api/auth/passkey/verify-registration", now)).toEqual({
      kind: "enrollment",
      allowed: false,
      expired: true,
    });
    expect(enrollmentGate(stale, "/api/auth/recovery/redeem", now)).toMatchObject({
      allowed: true,
      expired: true,
    });
    expect(enrollmentGate(stale, "/recuperacion", now)).toMatchObject({ allowed: true });
  });

  test("passkey sign-in stays possible, live or expired", () => {
    for (const session of [live, stale]) {
      for (const path of [
        "/api/auth/passkey/generate-authenticate-options",
        "/api/auth/passkey/verify-authentication",
      ]) {
        expect(enrollmentGate(session, path, now)).toMatchObject({ allowed: true });
      }
    }
  });

  test("a creation time in the future is expired", () => {
    const future = { enrollment: true, createdAt: new Date(now.getTime() + 1000) };
    expect(enrollmentGate(future, "/api/auth/passkey/verify-registration", now)).toMatchObject({
      allowed: false,
      expired: true,
    });
  });
});

import { describe, expect, it } from "bun:test";
import { passkeyErrors } from "#lib/auth-messages.ts";
import { requireUserVerified } from "./passkey-policy.ts";

describe("requireUserVerified", () => {
  it("accepts a verified ceremony", () => {
    expect(() => requireUserVerified(true)).not.toThrow();
  });

  it("rejects an unverified ceremony with a stable code and a Spanish message", () => {
    let thrown: unknown;
    try {
      requireUserVerified(false);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      status: "FORBIDDEN",
      body: passkeyErrors.userVerificationRequired,
    });
  });

  it("rejects when the verification result is missing", () => {
    expect(() => requireUserVerified(undefined)).toThrow();
  });
});

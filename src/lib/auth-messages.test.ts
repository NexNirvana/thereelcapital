import { describe, expect, it } from "bun:test";
import { passkeyErrorMessage, passkeyErrors } from "./auth-messages.ts";

describe("passkeyErrorMessage", () => {
  it("shows the Spanish message of a known code", () => {
    expect(passkeyErrorMessage("BANNED_USER")).toBe(passkeyErrors.banned.message);
    expect(passkeyErrorMessage("USER_VERIFICATION_REQUIRED")).toBe(
      passkeyErrors.userVerificationRequired.message,
    );
  });

  it("falls back to the generic message and never echoes unknown codes", () => {
    expect(passkeyErrorMessage("SOMETHING_INTERNAL")).toBe(passkeyErrors.generic.message);
    expect(passkeyErrorMessage(undefined)).toBe(passkeyErrors.generic.message);
  });
});

import { describe, expect, it } from "bun:test";
import {
  passkeyErrorMessage,
  passkeyErrors,
  enrollmentLost,
  finishEnrollmentErrorMessage,
  passkeyRegistrationErrorMessage,
  recoveryErrorMessage,
  recoveryErrors,
} from "./auth-messages.ts";

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

describe("recovery messages", () => {
  it("maps known codes and a rate-limit status to Spanish text", () => {
    expect(recoveryErrorMessage("PASSKEY_REQUIRED")).toBe(recoveryErrors.passkeyRequired.message);
    expect(recoveryErrorMessage(undefined, 429)).toBe(recoveryErrors.tooManyAttempts.message);
  });

  it("answers an unknown failure like a wrong code, never echoing it", () => {
    expect(recoveryErrorMessage("SOMETHING_INTERNAL")).toBe(recoveryErrors.invalidCode.message);
  });

  it("tells an expired enrollment apart from a failed passkey", () => {
    expect(recoveryErrorMessage("ENROLLMENT_EXPIRED")).toBe(
      recoveryErrors.enrollmentExpired.message,
    );
    expect(enrollmentLost("ENROLLMENT_EXPIRED")).toBe(true);
    expect(enrollmentLost(undefined, 401)).toBe(true);
    expect(enrollmentLost("USER_VERIFICATION_REQUIRED", 403)).toBe(false);
  });

  it("keeps the user-verification hint when registering a passkey", () => {
    expect(passkeyRegistrationErrorMessage("USER_VERIFICATION_REQUIRED")).toBe(
      passkeyErrors.userVerificationRequired.message,
    );
    expect(passkeyRegistrationErrorMessage("X")).toContain("registrar tu passkey");
  });
});

describe("finishEnrollmentErrorMessage", () => {
  it("keeps the passkey hint and the rate-limit text", () => {
    expect(finishEnrollmentErrorMessage("PASSKEY_REQUIRED")).toBe(
      recoveryErrors.passkeyRequired.message,
    );
    expect(finishEnrollmentErrorMessage(undefined, 429)).toBe(
      recoveryErrors.tooManyAttempts.message,
    );
  });

  it("never reads an unknown failure as a wrong code", () => {
    expect(finishEnrollmentErrorMessage("SOMETHING_INTERNAL")).toContain("terminar el registro");
  });
});

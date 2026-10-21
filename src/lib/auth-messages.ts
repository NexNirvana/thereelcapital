// Stable codes and the Spanish text shown for passkey failures. Client-safe: the server throws
// these (passkey-policy.ts) and /acceso looks them up by code, so server wording never reaches
// the page by accident and unknown errors fall back to the generic message.
export const passkeyErrors = {
  userVerificationRequired: {
    code: "USER_VERIFICATION_REQUIRED",
    message: "Tu passkey debe confirmar tu identidad con huella, rostro o PIN. Inténtalo de nuevo.",
  },
  banned: {
    code: "BANNED_USER",
    message: "Tu acceso está suspendido. Contacta al administrador.",
  },
  generic: {
    code: "PASSKEY_SIGN_IN_FAILED",
    message: "No pudimos iniciar sesión con tu passkey. Inténtalo de nuevo.",
  },
} as const;

export function passkeyErrorMessage(code: string | undefined): string {
  const known = Object.values(passkeyErrors).find((entry) => entry.code === code);
  return (known ?? passkeyErrors.generic).message;
}

/** Registering a passkey fails for different reasons than signing in with one. */
export function passkeyRegistrationErrorMessage(code: string | undefined): string {
  if (code === passkeyErrors.userVerificationRequired.code) {
    return passkeyErrors.userVerificationRequired.message;
  }
  return "No pudimos registrar tu passkey. Inténtalo de nuevo.";
}

// Recovery (docs/auth-and-security.md#flows). Same shape as passkeyErrors; the server throws the
// code and the Spanish text, the page looks the code up.
export const recoveryErrors = {
  invalidCode: {
    code: "INVALID_RECOVERY_CODE",
    // One answer for wrong, used and suspended-account codes, so it reveals nothing about which.
    message: "El código no es válido o ya se usó. Revisa que esté completo e inténtalo de nuevo.",
  },
  invalidInput: {
    code: "INVALID_INPUT",
    message: "Los datos enviados no son válidos.",
  },
  // Both codes mean the enrollment session is gone: start again with a code. ENROLLMENT_EXPIRED
  // comes from the request hook, ENROLLMENT_REQUIRED from finishing.
  enrollmentExpired: {
    code: "ENROLLMENT_EXPIRED",
    message: "Tu sesión de registro venció. Empieza de nuevo con un código de recuperación.",
  },
  enrollmentRequired: {
    code: "ENROLLMENT_REQUIRED",
    message: "Tu sesión de registro venció. Empieza de nuevo con un código de recuperación.",
  },
  passkeyRequired: {
    code: "PASSKEY_REQUIRED",
    message: "Registra tu nueva passkey antes de continuar.",
  },
  tooManyAttempts: {
    code: "RATE_LIMITED",
    message: "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.",
  },
} as const;

/** True when the enrollment session is gone, so the only way forward is a new code. */
export function enrollmentLost(code: string | undefined, status?: number): boolean {
  return (
    code === recoveryErrors.enrollmentExpired.code ||
    code === recoveryErrors.enrollmentRequired.code ||
    status === 401
  );
}

/** Spanish text for a failed recovery request; Better Auth answers 429 itself when rate limited. */
export function recoveryErrorMessage(code: string | undefined, status?: number): string {
  if (status === 429) return recoveryErrors.tooManyAttempts.message;
  const known = Object.values(recoveryErrors).find((entry) => entry.code === code);
  return (known ?? recoveryErrors.invalidCode).message;
}

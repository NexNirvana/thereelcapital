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

// What the client reads when connecting to TradeStation fails. The codes are the engine's stable
// error codes (engine/src/rpc.ts) plus the one the callback itself can see; the URL carries only a
// code, never a message or a detail (docs/auth-and-security.md#secrets).
export const connectionErrors = {
  AUTHORIZATION_DENIED: "No autorizaste el acceso en TradeStation. Puedes intentarlo de nuevo.",
  STATE_INVALID: "El enlace de autorización no es válido o venció. Vuelve a conectar.",
  TOKEN_EXCHANGE_FAILED:
    "TradeStation rechazó la autorización. Revisa tu API key y tu secreto, y vuelve a conectar.",
  PASTE_INVALID:
    "No reconocemos esa dirección. Copia la dirección completa de la barra del navegador, la que empieza con http://localhost:3000.",
  BROKER_UNAVAILABLE: "No pudimos comunicarnos con TradeStation. Inténtalo de nuevo.",
  INVALID_BROKER_RESPONSE: "TradeStation respondió algo inesperado. Inténtalo de nuevo.",
  CREDENTIALS_UNAVAILABLE: "No pudimos guardar tus credenciales. Avisa al administrador.",
} as const;

export type ConnectionErrorCode = keyof typeof connectionErrors;

export function isConnectionErrorCode(value: string | null): value is ConnectionErrorCode {
  return value !== null && Object.hasOwn(connectionErrors, value);
}

/** Codes arrive from the address bar, so anything that isn't one of ours shows nothing. */
export function connectionErrorFor(code: string | null) {
  return isConnectionErrorCode(code) ? { code, message: connectionErrors[code] } : null;
}

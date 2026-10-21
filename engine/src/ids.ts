// Intent ids double as TradeStation OrderConfirmIDs (22 characters at most).

/** 16 random bytes in base64url: 22 characters. */
export function newIntentId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

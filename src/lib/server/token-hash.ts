// Activation tokens and recovery codes are high-entropy random strings stored only as
// HMAC-SHA-256 with a server key (docs/auth-and-security.md#flows). Bun scripts and Workers
// both import this, so it uses WebCrypto and Buffer (nodejs_compat).

export type TokenPurpose = "activation-link" | "recovery-code" | "audit-ip";

/** 32 random bytes as base64url (43 characters). */
export function newActivationToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

/** Hex HMAC-SHA-256 of `token`, domain-separated by `purpose` so a hash never validates elsewhere. */
export async function hashToken(
  purpose: TokenPurpose,
  token: string,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`${purpose}:${token}`));
  return Buffer.from(mac).toString("hex");
}

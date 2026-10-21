// Recovery codes and audit IPs are stored as HMAC-SHA-256 with a server key; activation tokens
// (32 random bytes) as a plain domain-separated SHA-256 so the CLI scripts need no secret
// (docs/auth-and-security.md#flows, D32). Bun scripts and Workers both import this, so it uses
// WebCrypto and Buffer (nodejs_compat).

export type TokenPurpose = "recovery-code" | "audit-ip";

/** 32 random bytes as base64url (43 characters). */
export function newActivationToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

/** Hex SHA-256 of `activation-link:<token>`. The token has 256 bits of entropy, so no key is needed. */
export async function hashActivationToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`activation-link:${token}`),
  );
  return Buffer.from(digest).toString("hex");
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

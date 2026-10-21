// What an activation link is, shared by the server (`createClient`, regeneration) and
// `scripts/admin-create.ts` so there is one implementation of token, hash and expiry.
// Bun scripts and Workers both import this: WebCrypto only.
import { ACTIVATION_LINK_LIFETIME_MS } from "#lib/domain/config.ts";
import { hashToken, newActivationToken } from "./token-hash.ts";

/** The link a client opens: `<origin>/activar/<token>`. */
export const activationUrl = (origin: string, token: string) =>
  `${new URL(origin).origin}/activar/${token}`;

/** A new token with its stored form and expiry. The caller shows `token` once and drops it. */
export async function newInvitation(secret: string, now = Date.now()) {
  const token = newActivationToken();
  return {
    token,
    tokenHash: await hashToken("activation-link", token, secret),
    expiresAt: now + ACTIVATION_LINK_LIFETIME_MS,
  };
}

// docs/auth-and-security.md#gaps-in-better-auth-defaults: every passkey ceremony must prove user
// verification, which the plugin does not enforce on its own.
import { APIError } from "better-auth/api";
import { passkeyErrors } from "#lib/auth-messages.ts";

export const bannedUserMessage = passkeyErrors.banned.message;

/** `undefined` (no registration info) counts as unverified: unknown never passes. */
export function requireUserVerified(userVerified: boolean | undefined): void {
  if (userVerified !== true)
    throw APIError.from("FORBIDDEN", passkeyErrors.userVerificationRequired);
}

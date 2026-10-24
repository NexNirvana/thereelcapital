import { passkeyErrorMessage } from "#lib/auth-messages.ts";

/**
 * Signs in with a passkey and returns the Spanish failure message, or null on success. The Better
 * Auth client is imported here, on first use, so pages without a passkey prompt never load it. A
 * failed import (a chunk gone after a deploy, a flaky network) reads as a generic failure.
 */
export async function signInWithPasskey(): Promise<string | null> {
  try {
    const { authClient } = await import("#lib/auth-client.ts");
    const { error } = await authClient.signIn.passkey();
    return error ? passkeyErrorMessage("code" in error ? error.code : undefined) : null;
  } catch {
    return passkeyErrorMessage(undefined);
  }
}

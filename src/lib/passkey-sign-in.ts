import { passkeyErrorMessage } from "#lib/auth-messages.ts";

type AuthClientModule = typeof import("#lib/auth-client.ts");

/**
 * The loader is a parameter so tests can make the download fail; the app uses the instance below.
 * A rejected import is forgotten so the next call tries the download again.
 */
export function createPasskeySignIn(load: () => Promise<AuthClientModule>) {
  let clientModule: Promise<AuthClientModule> | undefined;
  const loadAuthClient = () => {
    clientModule ??= load().catch((error: unknown) => {
      clientModule = undefined;
      throw error;
    });
    return clientModule;
  };

  return {
    /**
     * Starts downloading the Better Auth client. A component that can prompt for a passkey calls it
     * on mount so the click only awaits a resolved module: Safari and iOS refuse WebAuthn when too
     * much happens between the tap and the prompt. Pages without such a component never call it, so
     * they never load the chunk. A failed warm-up is swallowed; the click retries the import.
     */
    warmPasskeyClient(): void {
      loadAuthClient().catch(() => undefined);
    },

    /**
     * Signs in with a passkey and returns the Spanish failure message, or null on success. A failed
     * import (a chunk gone after a deploy, a flaky network) reads as a generic failure.
     */
    async signInWithPasskey(): Promise<string | null> {
      try {
        const { authClient } = await loadAuthClient();
        const { error } = await authClient.signIn.passkey();
        return error ? passkeyErrorMessage("code" in error ? error.code : undefined) : null;
      } catch {
        return passkeyErrorMessage(undefined);
      }
    },
  };
}

export const { warmPasskeyClient, signInWithPasskey } = createPasskeySignIn(
  () => import("#lib/auth-client.ts"),
);

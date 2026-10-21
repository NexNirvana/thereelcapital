import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/svelte";

// Same origin as the page, so the browser sends the session cookie and the passkey's rpID matches.
export const authClient = createAuthClient({ plugins: [passkeyClient()] });

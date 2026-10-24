import { describe, expect, mock, test } from "bun:test";
import { passkeyErrors } from "./auth-messages.ts";

let signIn: () => Promise<{ error: null | { code?: string } }>;
mock.module("#lib/auth-client.ts", () => ({ authClient: { signIn: { passkey: () => signIn() } } }));
const { signInWithPasskey } = await import("./passkey-sign-in.ts");

describe("signInWithPasskey", () => {
  test("returns null when the passkey sign-in succeeds", async () => {
    signIn = async () => ({ error: null });
    expect(await signInWithPasskey()).toBeNull();
  });

  test("maps a known error code to its Spanish message", async () => {
    signIn = async () => ({ error: { code: passkeyErrors.banned.code } });
    expect(await signInWithPasskey()).toBe(passkeyErrors.banned.message);
  });

  test("falls back to the generic message when the client throws", async () => {
    signIn = async () => {
      throw new Error("chunk gone");
    };
    expect(await signInWithPasskey()).toBe(passkeyErrors.generic.message);
  });
});

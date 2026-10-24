import { describe, expect, mock, test } from "bun:test";
import { passkeyErrors } from "./auth-messages.ts";

let signIn: () => Promise<{ error: null | { code?: string } }>;
mock.module("#lib/auth-client.ts", () => ({ authClient: { signIn: { passkey: () => signIn() } } }));
const { createPasskeySignIn, signInWithPasskey, warmPasskeyClient } =
  await import("./passkey-sign-in.ts");

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

  test("warming the client does not throw and the sign-in still works afterwards", async () => {
    warmPasskeyClient();
    signIn = async () => ({ error: null });
    expect(await signInWithPasskey()).toBeNull();
  });

  test("a failed warm-up is forgotten so the next sign-in retries the import", async () => {
    let attempts = 0;
    const flaky = createPasskeySignIn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("chunk gone");
      return { authClient: { signIn: { passkey: () => signIn() } } } as never;
    });
    flaky.warmPasskeyClient();
    await new Promise((resolve) => setTimeout(resolve)); // the click comes after the warm-up failed
    signIn = async () => ({ error: null });
    expect(await flaky.signInWithPasskey()).toBeNull();
    expect(attempts).toBe(2);
  });

  test("shares one download between the warm-up and the click", async () => {
    let attempts = 0;
    const once = createPasskeySignIn(async () => {
      attempts += 1;
      return { authClient: { signIn: { passkey: () => signIn() } } } as never;
    });
    once.warmPasskeyClient();
    await once.signInWithPasskey();
    expect(attempts).toBe(1);
  });
});

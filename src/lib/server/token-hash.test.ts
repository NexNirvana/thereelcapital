import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { hashActivationToken, hashToken, newActivationToken } from "./token-hash";

describe("hashToken", () => {
  it("matches an independent HMAC-SHA-256 over purpose:token", async () => {
    const expected = createHmac("sha256", "server-key").update("recovery-code:abc").digest("hex");
    expect(await hashToken("recovery-code", "abc", "server-key")).toBe(expected);
  });

  it("separates purposes and keys", async () => {
    const code = await hashToken("recovery-code", "abc", "server-key");
    expect(await hashToken("audit-ip", "abc", "server-key")).not.toBe(code);
    expect(await hashToken("recovery-code", "abc", "other-key")).not.toBe(code);
  });
});

describe("hashActivationToken", () => {
  it("is the plain SHA-256 of activation-link:token, with no key", async () => {
    const expected = createHash("sha256").update("activation-link:abc").digest("hex");
    expect(await hashActivationToken("abc")).toBe(expected);
  });

  it("differs from the keyed recovery-code hash of the same string", async () => {
    expect(await hashActivationToken("abc")).not.toBe(await hashToken("recovery-code", "abc", "k"));
  });
});

describe("newActivationToken", () => {
  it("is 32 random bytes in URL-safe base64 without padding", () => {
    const token = newActivationToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newActivationToken()).not.toBe(token);
  });
});

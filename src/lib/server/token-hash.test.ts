import { createHmac } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { hashToken, newActivationToken } from "./token-hash";

describe("hashToken", () => {
  it("matches an independent HMAC-SHA-256 over purpose:token", async () => {
    const expected = createHmac("sha256", "server-key").update("activation-link:abc").digest("hex");
    expect(await hashToken("activation-link", "abc", "server-key")).toBe(expected);
  });

  it("separates purposes and keys", async () => {
    const link = await hashToken("activation-link", "abc", "server-key");
    expect(await hashToken("recovery-code", "abc", "server-key")).not.toBe(link);
    expect(await hashToken("activation-link", "abc", "other-key")).not.toBe(link);
  });
});

describe("newActivationToken", () => {
  it("is 32 random bytes in URL-safe base64 without padding", () => {
    const token = newActivationToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newActivationToken()).not.toBe(token);
  });
});

import { describe, expect, it } from "vitest";
import { createCipher, CredentialsKeyError } from "../src/crypto";

const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const otherKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

describe("credential cipher", () => {
  it("round-trips a value and never repeats a nonce", async () => {
    const cipher = await createCipher(key);
    const first = await cipher.encrypt("s3cret", "user-1:client_secret");
    const second = await cipher.encrypt("s3cret", "user-1:client_secret");
    expect(first).not.toBe(second);
    expect(first).not.toContain("s3cret");
    expect(await cipher.decrypt(first, "user-1:client_secret")).toBe("s3cret");
  });

  it("uses a 12-byte nonce", async () => {
    const cipher = await createCipher(key);
    const [nonce] = (await cipher.encrypt("x", "c")).split(".");
    expect(atob(nonce ?? "")).toHaveLength(12);
  });

  it("refuses a blob moved to another user or field", async () => {
    const cipher = await createCipher(key);
    const blob = await cipher.encrypt("s3cret", "user-1:client_secret");
    await expect(cipher.decrypt(blob, "user-2:client_secret")).rejects.toThrow();
    await expect(cipher.decrypt(blob, "user-1:refresh_token")).rejects.toThrow();
  });

  it("refuses a blob sealed with another key and gives each key its own id", async () => {
    const cipher = await createCipher(key);
    const other = await createCipher(otherKey);
    expect(cipher.keyId).toMatch(/^[0-9a-f]{8}$/);
    expect(cipher.keyId).not.toBe(other.keyId);
    await expect(other.decrypt(await cipher.encrypt("x", "c"), "c")).rejects.toThrow();
  });

  it("rejects a missing, malformed or short key", async () => {
    for (const bad of [undefined, "", "not base64!!", btoa("short")]) {
      await expect(createCipher(bad)).rejects.toBeInstanceOf(CredentialsKeyError);
    }
  });
});

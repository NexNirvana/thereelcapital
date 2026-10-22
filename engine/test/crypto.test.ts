import { describe, expect, it } from "vitest";
import { createCipher, CredentialsKeyError, UnknownKeyIdError } from "../src/crypto";

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

  it("reads what the previous key sealed, and seals only with the current one", async () => {
    const old = await createCipher(otherKey);
    const rotated = await createCipher(key, otherKey);
    const blob = await old.encrypt("s3cret", "c");
    expect(await rotated.decrypt(blob, "c", old.keyId)).toBe("s3cret");
    expect(rotated.keyId).toBe((await createCipher(key)).keyId);
    const fresh = await rotated.encrypt("s3cret", "c");
    await expect(old.decrypt(fresh, "c")).rejects.toThrow();
  });

  it("fails closed with a typed error on a key_id that neither key has", async () => {
    const rotated = await createCipher(key, otherKey);
    const blob = await rotated.encrypt("s3cret", "c");
    await expect(rotated.decrypt(blob, "c", "deadbeef")).rejects.toBeInstanceOf(UnknownKeyIdError);
    const noPrevious = await createCipher(key);
    const old = await createCipher(otherKey);
    await expect(
      noPrevious.decrypt(await old.encrypt("x", "c"), "c", old.keyId),
    ).rejects.toBeInstanceOf(UnknownKeyIdError);
  });

  it("rejects a malformed previous key without echoing it", async () => {
    await expect(createCipher(key, "nope!!")).rejects.toThrow(
      /^CREDENTIALS_KEY_PREVIOUS is not base64$/,
    );
  });
});

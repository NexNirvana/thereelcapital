// AES-GCM for broker credentials (docs/auth-and-security.md#secrets). Only the engine holds the
// key and only the engine decrypts, so the web Worker never sees a secret or a token again.

const NONCE_BYTES = 12;
const KEY_BYTES = 32;

export class CredentialsKeyError extends Error {}

/** The stored key_id matches neither the current nor the previous key: the client must reconnect. */
export class UnknownKeyIdError extends Error {}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

export interface CredentialCipher {
  /** Fingerprint of the current key, stored next to each ciphertext so a rotation can tell them apart. */
  readonly keyId: string;
  /** `context` (user id and field) is authenticated but not stored: a blob moved elsewhere fails. */
  encrypt(plaintext: string, context: string): Promise<string>;
  /**
   * `keyId` is the one stored with the blob: the current key or, during a rotation, the previous
   * one. Any other id throws UnknownKeyIdError. Without it the current key is used.
   */
  decrypt(blob: string, context: string, keyId?: string): Promise<string>;
}

interface LoadedKey {
  readonly keyId: string;
  readonly key: CryptoKey;
}

/** `secret` is base64 of 32 random bytes (`openssl rand -base64 32`). */
async function loadKey(secret: string | undefined, name: string): Promise<LoadedKey> {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = fromBase64(secret ?? "");
  } catch {
    throw new CredentialsKeyError(`${name} is not base64`);
  }
  if (raw.length !== KEY_BYTES) throw new CredentialsKeyError(`${name} must be 32 bytes`);

  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  const fingerprint = await crypto.subtle.digest("SHA-256", raw);
  const keyId = Array.from(new Uint8Array(fingerprint).slice(0, 4), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return { keyId, key };
}

/**
 * Encrypts with `secret` only. `previousSecret` (CREDENTIALS_KEY_PREVIOUS, set during a rotation)
 * is accepted for decrypting what the old key sealed; callers re-encrypt it with the current key.
 */
export async function createCipher(
  secret: string | undefined,
  previousSecret?: string,
): Promise<CredentialCipher> {
  const current = await loadKey(secret, "CREDENTIALS_KEY");
  const previous =
    previousSecret === undefined || previousSecret === ""
      ? null
      : await loadKey(previousSecret, "CREDENTIALS_KEY_PREVIOUS");
  const additionalData = (context: string) => new TextEncoder().encode(context);

  return {
    keyId: current.keyId,
    async encrypt(plaintext, context) {
      const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
      const sealed = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData: additionalData(context) },
        current.key,
        new TextEncoder().encode(plaintext),
      );
      return `${toBase64(nonce)}.${toBase64(new Uint8Array(sealed))}`;
    },
    async decrypt(blob, context, keyId = current.keyId) {
      const loaded = [current, previous].find((candidate) => candidate?.keyId === keyId);
      if (loaded === undefined || loaded === null) throw new UnknownKeyIdError("unknown key_id");
      const [nonce, sealed] = blob.split(".");
      if (nonce === undefined || sealed === undefined) throw new Error("malformed ciphertext");
      const opened = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromBase64(nonce), additionalData: additionalData(context) },
        loaded.key,
        fromBase64(sealed),
      );
      return new TextDecoder().decode(opened);
    },
  };
}

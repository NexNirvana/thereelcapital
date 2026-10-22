import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCipher } from "../src/crypto";
import { TokenRefresher } from "../src/refresh";

// docs/runbook.md#secrets: CREDENTIALS_KEY_PREVIOUS keeps clients connected across a rotation.
const CLIENT_SECRET = "ts-client-secret-SHOULD-NEVER-LEAK";
const REFRESH = "refresh-token-SHOULD-NEVER-LEAK";
const ACCESS = "access-token-SHOULD-NEVER-LEAK";
const T0 = 1_800_000_000_000;
// The pool's CREDENTIALS_KEY is the "new" key; this one plays the key being retired.
const OLD_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
const STRANGER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(6)));

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(JSON.stringify({ access_token: ACCESS, expires_in: 1200 }), {
        headers: { "content-type": "application/json" },
      }),
  );
});
afterEach(() => vi.restoreAllMocks());

let counter = 0;
async function clientSealedWith(sealKey: string) {
  const userId = `rotation-user-${++counter}`;
  await env.DB.prepare(
    `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Test', ?, 1, 0, 0)`,
  )
    .bind(userId, `${userId}@example.test`)
    .run();
  const sealer = await createCipher(sealKey);
  await env.DB.prepare(
    `INSERT INTO broker_connection
       (user_id, client_id, client_secret_enc, refresh_token_enc, key_id, refresh_expires_at, status, last_ok_at)
     VALUES (?, 'ts-client-id', ?, ?, ?, NULL, 'CONNECTED', ?)`,
  )
    .bind(
      userId,
      await sealer.encrypt(CLIENT_SECRET, `${userId}:client_secret`),
      await sealer.encrypt(REFRESH, `${userId}:refresh_token`),
      sealer.keyId,
      T0,
    )
    .run();
  return { userId, stub: env.COORDINATOR.getByName(userId), oldKeyId: sealer.keyId };
}

const rowOf = (userId: string) =>
  env.DB.prepare("SELECT * FROM broker_connection WHERE user_id = ?")
    .bind(userId)
    .first<Record<string, string | number | null>>();

function refreshWith(client: { userId: string; stub: DurableObjectStub }, previous?: string) {
  return runInDurableObject(client.stub, async (_instance, state) => {
    const tokens = new TokenRefresher({
      sql: state.storage.sql,
      storage: state.storage,
      db: env.DB,
      userId: client.userId,
      cipher: () => createCipher(env.CREDENTIALS_KEY, previous),
      clock: () => T0,
      retryDelayMs: 0,
    });
    const outcome = await tokens.refresh();
    const events = state.storage.sql.exec("SELECT type, data_json FROM events").toArray();
    return { outcome, events };
  });
}

describe("CREDENTIALS_KEY rotation", () => {
  it("refreshes with the previous key and moves the row to the current key_id", async () => {
    const client = await clientSealedWith(OLD_KEY);
    const current = await createCipher(env.CREDENTIALS_KEY);
    expect(client.oldKeyId).not.toBe(current.keyId);

    const { outcome } = await refreshWith(client, OLD_KEY);
    expect(outcome.kind).toBe("ready");

    const row = await rowOf(client.userId);
    expect(row?.key_id).toBe(current.keyId);
    expect(row?.status).toBe("CONNECTED");
    // Both ciphertexts now open with the current key alone.
    expect(
      await current.decrypt(String(row?.client_secret_enc), `${client.userId}:client_secret`),
    ).toBe(CLIENT_SECRET);
    expect(
      await current.decrypt(String(row?.refresh_token_enc), `${client.userId}:refresh_token`),
    ).toBe(REFRESH);
  });

  it("leaves a row already on the current key untouched", async () => {
    const client = await clientSealedWith(env.CREDENTIALS_KEY);
    const before = await rowOf(client.userId);
    expect((await refreshWith(client, OLD_KEY)).outcome.kind).toBe("ready");
    const after = await rowOf(client.userId);
    expect(after?.refresh_token_enc).toBe(before?.refresh_token_enc);
    expect(after?.client_secret_enc).toBe(before?.client_secret_enc);
  });

  it("needs a reconnect, without crashing, when the key_id matches no configured key", async () => {
    const client = await clientSealedWith(STRANGER_KEY);
    const { outcome, events } = await refreshWith(client, OLD_KEY);
    expect(outcome).toEqual({ kind: "terminal", state: "EXPIRED" });
    expect((await rowOf(client.userId))?.status).toBe("EXPIRED");
    expect(JSON.stringify(events)).toContain("KEY_UNKNOWN");
  });

  it("puts no key material, secret or token in events", async () => {
    for (const key of [OLD_KEY, STRANGER_KEY]) {
      const { events } = await refreshWith(await clientSealedWith(key), OLD_KEY);
      const logged = JSON.stringify(events);
      for (const leaked of [
        OLD_KEY,
        STRANGER_KEY,
        env.CREDENTIALS_KEY,
        CLIENT_SECRET,
        REFRESH,
        ACCESS,
      ]) {
        expect(logged).not.toContain(leaked);
      }
    }
  });
});

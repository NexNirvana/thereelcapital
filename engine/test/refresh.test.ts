import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCipher } from "../src/crypto";
import { markReconciled, reconciliationPending, TokenRefresher } from "../src/refresh";

const CLIENT_ID = "ts-client-id-0123456789abcdef";
const CLIENT_SECRET = "ts-client-secret-SHOULD-NEVER-LEAK";
const OLD_REFRESH = "refresh-token-old-SHOULD-NEVER-LEAK";
const NEW_REFRESH = "refresh-token-new-SHOULD-NEVER-LEAK";
const ACCESS = "access-token-SHOULD-NEVER-LEAK";
const SECRETS = [CLIENT_SECRET, OLD_REFRESH, NEW_REFRESH, ACCESS];
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = 1_800_000_000_000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let bodies: URLSearchParams[] = [];
let respond: () => Response | Promise<Response>;
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  bodies = [];
  respond = () => json({ access_token: ACCESS, expires_in: 1200 });
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== "https://signin.tradestation.com/oauth/token") {
      throw new Error(`unexpected request to ${url}`);
    }
    bodies.push(new URLSearchParams(String(init?.body)));
    return respond();
  });
});
afterEach(() => vi.restoreAllMocks());

let counter = 0;
async function newClient(refreshExpiresAt: number | null = null) {
  const userId = `refresh-user-${++counter}`;
  await env.DB.prepare(
    `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Test', ?, 1, 0, 0)`,
  )
    .bind(userId, `${userId}@example.test`)
    .run();
  const cipher = await createCipher(env.CREDENTIALS_KEY);
  await env.DB.prepare(
    `INSERT INTO broker_connection
       (user_id, client_id, client_secret_enc, refresh_token_enc, key_id, refresh_expires_at, status, last_ok_at)
     VALUES (?, ?, ?, ?, ?, ?, 'CONNECTED', ?)`,
  )
    .bind(
      userId,
      CLIENT_ID,
      await cipher.encrypt(CLIENT_SECRET, `${userId}:client_secret`),
      await cipher.encrypt(OLD_REFRESH, `${userId}:refresh_token`),
      cipher.keyId,
      refreshExpiresAt,
      T0,
    )
    .run();
  return { userId, stub: env.COORDINATOR.getByName(userId), cipher };
}
type Client = Awaited<ReturnType<typeof newClient>>;

/** Runs `body` inside the client's Durable Object with a refresher on a fake clock. */
function withRefresher<T>(
  client: Client,
  body: (tokens: TokenRefresher, time: { now: number }, deps: Deps) => Promise<T>,
) {
  const time = { now: T0 };
  return runInDurableObject(client.stub, async (_instance, state) => {
    const deps = {
      sql: state.storage.sql,
      storage: state.storage,
      db: env.DB,
      userId: client.userId,
    };
    const tokens = new TokenRefresher({
      ...deps,
      cipher: () => createCipher(env.CREDENTIALS_KEY),
      clock: () => time.now,
      retryDelayMs: 0,
    });
    return body(tokens, time, deps);
  });
}
type Deps = Pick<
  ConstructorParameters<typeof TokenRefresher>[0],
  "sql" | "storage" | "db" | "userId"
>;

const storedRow = (userId: string) =>
  env.DB.prepare("SELECT * FROM broker_connection WHERE user_id = ?")
    .bind(userId)
    .first<Record<string, string | number | null>>();
const eventsOf = (client: Client) =>
  runInDurableObject(client.stub, (_i, state) =>
    state.storage.sql.exec("SELECT type, level, data_json FROM events").toArray(),
  );
const refreshTokenOf = async (client: Client) =>
  client.cipher.decrypt(
    String((await storedRow(client.userId))?.refresh_token_enc),
    `${client.userId}:refresh_token`,
  );

describe("accessToken", () => {
  it("refreshes when none is held and then reuses the token until the margin", async () => {
    const client = await newClient();
    await withRefresher(client, async (tokens, time) => {
      expect(await tokens.accessToken()).toEqual({ ok: true, token: ACCESS });
      expect(bodies).toHaveLength(1);
      expect(Object.fromEntries(bodies[0] ?? [])).toEqual({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: OLD_REFRESH,
      });

      time.now += 14 * MINUTE; // 6 minutes left, outside the 5 minute margin
      await tokens.accessToken();
      expect(bodies).toHaveLength(1);

      time.now += 2 * MINUTE; // 4 minutes left: refreshed before it expires
      await tokens.accessToken();
      expect(bodies).toHaveLength(2);
    });
  });

  it("schedules the next refresh before the 20 minute expiry", async () => {
    const client = await newClient();
    await withRefresher(client, async (tokens) => {
      expect(tokens.nextRefreshAt()).toBeNull();
      tokens.seed(ACCESS, 1200);
      expect(tokens.nextRefreshAt()).toBe(T0 + 15 * MINUTE);
    });
  });

  it("shares one request among concurrent callers (single flight)", async () => {
    const client = await newClient();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    respond = async () => {
      await gate;
      return json({ access_token: ACCESS, expires_in: 1200 });
    };
    await withRefresher(client, async (tokens) => {
      const callers = [
        tokens.accessToken(),
        tokens.accessToken(),
        tokens.refresh(),
        tokens.accessToken(),
      ];
      await vi.waitFor(() => expect(bodies).toHaveLength(1));
      release();
      const results = await Promise.all(callers);
      expect(bodies).toHaveLength(1);
      expect(results[0]).toEqual({ ok: true, token: ACCESS });
      expect(results[3]).toEqual({ ok: true, token: ACCESS });
      // The slot is free again afterwards.
      await tokens.refresh();
      expect(bodies).toHaveLength(2);
    });
  });
});

describe("rotation", () => {
  it("persists a new refresh token encrypted, sets the 24h expiry and uses it next time", async () => {
    const client = await newClient();
    respond = () => json({ access_token: ACCESS, expires_in: 1200, refresh_token: NEW_REFRESH });
    await withRefresher(client, async (tokens, time) => {
      await tokens.refresh();
      const row = await storedRow(client.userId);
      expect(JSON.stringify(row)).not.toContain(NEW_REFRESH);
      expect(await refreshTokenOf(client)).toBe(NEW_REFRESH);
      expect(row).toMatchObject({
        status: "CONNECTED",
        refresh_expires_at: T0 + 24 * HOUR,
        last_ok_at: T0,
      });

      // The lifetime is absolute: a later rotation does not extend it.
      time.now += 15 * MINUTE;
      respond = () =>
        json({ access_token: ACCESS, expires_in: 1200, refresh_token: "third-token" });
      await tokens.refresh();
      expect(bodies[1]?.get("refresh_token")).toBe(NEW_REFRESH);
      expect((await storedRow(client.userId))?.refresh_expires_at).toBe(T0 + 24 * HOUR);
    });
    expect(JSON.stringify(await eventsOf(client))).toContain("broker.rotation_detected");
  });

  it("keeps the stored token and an unknown expiry when the response has no new one", async () => {
    const client = await newClient();
    const before = await storedRow(client.userId);
    await withRefresher(client, (tokens) => tokens.refresh());
    const after = await storedRow(client.userId);
    expect(after?.refresh_token_enc).toBe(before?.refresh_token_enc);
    expect(after?.refresh_expires_at).toBeNull();
    expect(await refreshTokenOf(client)).toBe(OLD_REFRESH);
  });

  it("drops the result when the client reconnected while the request was out", async () => {
    const client = await newClient();
    respond = async () => {
      await env.DB.prepare(
        "UPDATE broker_connection SET refresh_token_enc = 'replaced' WHERE user_id = ?",
      )
        .bind(client.userId)
        .run();
      return json({ access_token: ACCESS, expires_in: 1200, refresh_token: NEW_REFRESH });
    };
    await withRefresher(client, async (tokens) => {
      await tokens.refresh();
      expect(tokens.nextRefreshAt()).toBeNull();
    });
    expect((await storedRow(client.userId))?.refresh_token_enc).toBe("replaced");
  });

  it("keeps a rotated token it could not save and writes it on the next refresh", async () => {
    const client = await newClient();
    respond = () => json({ access_token: ACCESS, expires_in: 1200, refresh_token: NEW_REFRESH });
    await withRefresher(client, async (tokens, _time, deps) => {
      const realPrepare = env.DB.prepare.bind(env.DB);
      let broken = true;
      const flaky = new Proxy(env.DB, {
        get: (target, prop) =>
          prop === "prepare"
            ? (sql: string) => {
                if (broken && sql.includes("UPDATE broker_connection")) throw new Error("d1 down");
                return realPrepare(sql);
              }
            : Reflect.get(target, prop),
      });
      const flakyTokens = new TokenRefresher({
        ...deps,
        db: flaky,
        cipher: () => createCipher(env.CREDENTIALS_KEY),
        clock: () => T0,
        retryDelayMs: 0,
      });
      await flakyTokens.refresh();
      expect(await refreshTokenOf(client)).toBe(OLD_REFRESH);

      broken = false;
      respond = () => json({ access_token: ACCESS, expires_in: 1200 });
      await flakyTokens.refresh();
      // The unsaved token, not the retired one, went out and is now stored.
      expect(bodies[1]?.get("refresh_token")).toBe(NEW_REFRESH);
      // The response did not rotate, yet the only valid token reached the database.
      expect(await refreshTokenOf(client)).toBe(NEW_REFRESH);
    });
    expect(JSON.stringify(await eventsOf(client))).toContain("broker.rotation_not_saved");
  });
});

describe("an unsaved rotated token", () => {
  it("is kept encrypted in Durable Object storage and recovered by a new instance after eviction", async () => {
    const client = await newClient();
    respond = () => json({ access_token: ACCESS, expires_in: 1200, refresh_token: NEW_REFRESH });
    await withRefresher(client, async (_tokens, _time, deps) => {
      const realPrepare = env.DB.prepare.bind(env.DB);
      const down = new Proxy(env.DB, {
        get: (target, prop) =>
          prop === "prepare"
            ? (sql: string) => {
                if (sql.includes("UPDATE broker_connection")) throw new Error("d1 down");
                return realPrepare(sql);
              }
            : Reflect.get(target, prop),
      });
      const options = {
        ...deps,
        cipher: () => createCipher(env.CREDENTIALS_KEY),
        clock: () => T0,
        retryDelayMs: 0,
      };
      await new TokenRefresher({ ...options, db: down }).refresh();
      expect(await refreshTokenOf(client)).toBe(OLD_REFRESH);

      const kept = JSON.stringify([...deps.storage.kv.list()]);
      expect(kept).toContain("unsaved_refresh_token");
      expect(kept).not.toContain(NEW_REFRESH);

      // A new instance has no memory of the failed write; it reads the token from storage.
      respond = () => json({ access_token: ACCESS, expires_in: 1200 });
      await new TokenRefresher({ ...options, db: env.DB }).refresh();
      expect(bodies[1]?.get("refresh_token")).toBe(NEW_REFRESH);
      expect(await refreshTokenOf(client)).toBe(NEW_REFRESH);
      expect([...deps.storage.kv.list()].some(([key]) => key === "unsaved_refresh_token")).toBe(
        false,
      );
    });
  });
});

describe("failures", () => {
  async function seedPosition(client: Client) {
    await runInDurableObject(client.stub, (_i, state) =>
      state.storage.sql.exec(
        `INSERT INTO positions (id, mode, account_id, symbol, original_qty, avg_entry_price, stop_pct,
           trailing_unlock_pct, protection_state, status, opened_on)
         VALUES ('p1', 'SIM', 'SIM1001', 'AAPL', 10, 1, 30, 70, 'verified', 'OPEN', '2026-10-21')`,
      ),
    );
  }
  const protectionOf = (client: Client) =>
    runInDurableObject(
      client.stub,
      (_i, state) =>
        state.storage.sql.exec("SELECT protection_state FROM positions").one().protection_state,
    );

  it("treats a refused refresh as revoked, blocks entries and marks protection unverified", async () => {
    const client = await newClient();
    await seedPosition(client);
    respond = () => json({ error: "invalid_grant", error_description: OLD_REFRESH }, 400);
    await withRefresher(client, async (tokens, _t, deps) => {
      expect(await tokens.refresh()).toEqual({ kind: "terminal", state: "REVOKED" });
      expect(await tokens.accessToken()).toMatchObject({ ok: false });
      expect(reconciliationPending(deps.storage)).toBe(true);
    });
    expect((await storedRow(client.userId))?.status).toBe("REVOKED");
    expect(await protectionOf(client)).toBe("unverified");
    const events = JSON.stringify(await eventsOf(client));
    expect(events).toContain("broker.refresh_failed");
    for (const secret of SECRETS) expect(events).not.toContain(secret);
  });

  it("expires a rotating token whose absolute lifetime ran out without asking TradeStation", async () => {
    const client = await newClient(T0 - 1);
    await withRefresher(client, async (tokens, _t, deps) => {
      expect(await tokens.refresh()).toEqual({ kind: "terminal", state: "EXPIRED" });
      expect(reconciliationPending(deps.storage)).toBe(true);
    });
    expect(bodies).toHaveLength(0);
    expect((await storedRow(client.userId))?.status).toBe("EXPIRED");
  });

  it("records a failure when the credentials cannot be decrypted", async () => {
    const client = await newClient();
    await seedPosition(client);
    await withRefresher(client, async (_tokens, _t, deps) => {
      const broken = new TokenRefresher({
        ...deps,
        cipher: () => Promise.reject(new Error("key unusable")),
        clock: () => T0,
        retryDelayMs: 0,
      });
      expect(await broken.refresh()).toEqual({ kind: "retryable" });
      expect(reconciliationPending(deps.storage)).toBe(true);
    });
    expect(bodies).toHaveLength(0);
    expect((await storedRow(client.userId))?.status).toBe("ERROR");
    expect(await protectionOf(client)).toBe("unverified");
    expect(JSON.stringify(await eventsOf(client))).toContain("CREDENTIALS");
  });

  it("drops a refresh that finishes after the client reconnected", async () => {
    const client = await newClient();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    respond = async () => {
      await gate;
      return json({ error: "invalid_grant" }, 400);
    };
    await withRefresher(client, async (tokens, _t, deps) => {
      const pending = tokens.refresh();
      await vi.waitFor(() => expect(bodies).toHaveLength(1));
      tokens.seed("new-grant-access-token", 1200); // the reconnect lands while the request is out
      release();
      expect(await pending).toEqual({ kind: "none" });
      expect(reconciliationPending(deps.storage)).toBe(false);
      expect(tokens.nextRefreshAt()).toBe(T0 + 15 * MINUTE);
    });
    expect((await storedRow(client.userId))?.status).toBe("CONNECTED");
  });

  it("does not call TradeStation again once the connection is revoked", async () => {
    const client = await newClient();
    respond = () => json({ error: "invalid_grant" }, 400);
    await withRefresher(client, async (tokens) => {
      await tokens.refresh();
      await tokens.refresh();
    });
    expect(bodies).toHaveLength(1);
  });

  it("retries a network error a bounded number of times, then reports error", async () => {
    const client = await newClient();
    await seedPosition(client);
    fetchSpy.mockImplementation(async () => {
      throw new TypeError("network down");
    });
    await withRefresher(client, async (tokens, _t, deps) => {
      expect(await tokens.refresh()).toEqual({ kind: "retryable" });
      expect(fetchSpy).toHaveBeenCalledTimes(3); // one attempt and two retries
      expect(reconciliationPending(deps.storage)).toBe(true);
    });
    expect((await storedRow(client.userId))?.status).toBe("ERROR");
    expect(await protectionOf(client)).toBe("unverified");
  });

  it("retries a 503 and succeeds when TradeStation recovers, without blocking", async () => {
    const client = await newClient();
    let attempts = 0;
    respond = () =>
      ++attempts < 3
        ? new Response(null, { status: 503 })
        : json({ access_token: ACCESS, expires_in: 1200 });
    await withRefresher(client, async (tokens, _t, deps) => {
      expect(await tokens.refresh()).toMatchObject({ kind: "ready" });
      expect(reconciliationPending(deps.storage)).toBe(false);
    });
    expect(bodies).toHaveLength(3);
  });

  it("does not retry a refusal", async () => {
    const client = await newClient();
    respond = () => json({ error: "invalid_client" }, 401);
    await withRefresher(client, (tokens) => tokens.refresh());
    expect(bodies).toHaveLength(1);
  });

  it("treats an undecodable response as an error without retrying or revoking", async () => {
    const client = await newClient();
    respond = () => json({ nope: true });
    await withRefresher(client, async (tokens) => {
      expect(await tokens.refresh()).toEqual({ kind: "retryable" });
    });
    expect(bodies).toHaveLength(1);
    expect((await storedRow(client.userId))?.status).toBe("ERROR");
  });

  it("recovers from error on the next good refresh but keeps entries blocked until reconciled", async () => {
    const client = await newClient();
    respond = () => new Response(null, { status: 500 });
    await withRefresher(client, async (tokens, _t, deps) => {
      await tokens.refresh();
      respond = () => json({ access_token: ACCESS, expires_in: 1200 });
      expect(await tokens.refresh()).toMatchObject({ kind: "ready" });
      expect((await storedRow(client.userId))?.status).toBe("CONNECTED");
      expect(reconciliationPending(deps.storage)).toBe(true);
      expect(await markReconciled(deps)).toBe(true);
      expect(reconciliationPending(deps.storage)).toBe(false);
    });
    expect(JSON.stringify(await eventsOf(client))).toContain("broker.refresh_recovered");
  });

  it("does not lift a block raised while markReconciled was waiting", async () => {
    const client = await newClient();
    respond = () => new Response(null, { status: 500 });
    await withRefresher(client, async (tokens, _t, deps) => {
      await tokens.refresh(); // first failure: pending, status ERROR
      await env.DB.prepare("UPDATE broker_connection SET status = 'CONNECTED' WHERE user_id = ?")
        .bind(client.userId)
        .run();
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      const realPrepare = env.DB.prepare.bind(env.DB);
      const slow = new Proxy(env.DB, {
        get: (target, prop) =>
          prop === "prepare"
            ? (sql: string) => {
                const statement = realPrepare(sql);
                if (!sql.startsWith("SELECT status")) return statement;
                return new Proxy(statement, {
                  get: (inner, key) =>
                    key === "bind"
                      ? (...args: unknown[]) => {
                          const bound = inner.bind(...args);
                          return new Proxy(bound, {
                            get: (b, k) =>
                              k === "first"
                                ? async (...a: unknown[]) => {
                                    await gate;
                                    return (b.first as (...x: unknown[]) => unknown)(...a);
                                  }
                                : Reflect.get(b, k),
                          });
                        }
                      : Reflect.get(inner, key),
                });
              }
            : Reflect.get(target, prop),
      });
      const waiting = markReconciled({ ...deps, db: slow });
      // A refresh fails while the reconciliation is still reading the status.
      await env.DB.prepare("UPDATE broker_connection SET status = 'CONNECTED' WHERE user_id = ?")
        .bind(client.userId)
        .run();
      await tokens.refresh();
      // The status read still sees a usable connection, so only the counter can stop the lift.
      await env.DB.prepare("UPDATE broker_connection SET status = 'CONNECTED' WHERE user_id = ?")
        .bind(client.userId)
        .run();
      release();
      expect(await waiting).toBe(false);
      expect(reconciliationPending(deps.storage)).toBe(true);

      // Without interleaving the same call lifts it.
      await env.DB.prepare("UPDATE broker_connection SET status = 'CONNECTED' WHERE user_id = ?")
        .bind(client.userId)
        .run();
      expect(await markReconciled(deps)).toBe(true);
    });
  });

  it("refuses to lift the block while the connection is unusable", async () => {
    const client = await newClient();
    respond = () => json({ error: "invalid_grant" }, 400);
    await withRefresher(client, async (tokens, _t, deps) => {
      await tokens.refresh();
      expect(await markReconciled(deps)).toBe(false);
      expect(reconciliationPending(deps.storage)).toBe(true);
    });
  });
});

describe("connection RPC", () => {
  it("reports the health and the entry block, and carries no token", async () => {
    const client = await newClient(Date.now() + HOUR);
    const view = await client.stub.connection({ mode: "SIM" });
    expect(view).toMatchObject({
      ok: true,
      value: {
        status: "CONNECTED",
        health: { status: "expiring" },
        entriesBlocked: false,
      },
    });
    for (const secret of SECRETS) expect(JSON.stringify(view)).not.toContain(secret);

    await env.DB.prepare("UPDATE broker_connection SET status = 'REVOKED' WHERE user_id = ?")
      .bind(client.userId)
      .run();
    expect(await client.stub.connection({ mode: "SIM" })).toMatchObject({
      value: { health: { status: "revoked" }, entriesBlocked: true },
    });
  });

  it("shows an unknown expiry as null while healthy", async () => {
    const client = await newClient();
    expect(await client.stub.connection({ mode: "SIM" })).toMatchObject({
      value: { health: { status: "ok" }, refreshExpiresAt: null, entriesBlocked: false },
    });
  });
});

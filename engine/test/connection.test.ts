import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCipher } from "../src/crypto";
import { AlarmScheduler } from "../src/scheduler";
import { holdForReconciliation, markReconciled, reconciliationPending } from "../src/refresh";

const CLIENT_ID = "ts-client-id-0123456789abcdef";
const CLIENT_SECRET = "ts-client-secret-SHOULD-NEVER-LEAK";
const ACCESS_TOKEN = "access-token-SHOULD-NEVER-LEAK";
const REFRESH_TOKEN = "refresh-token-SHOULD-NEVER-LEAK";
// Paste mode (D35); the registered callback URL is accepted too (engine/src/rpc.ts).
const REDIRECT_URI = "http://localhost:3000";
const SECRETS = [CLIENT_SECRET, ACCESS_TOKEN, REFRESH_TOKEN];

interface Call {
  url: string;
  body: string;
  authorization: string | null;
}
type Responder = (call: Call) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ACCOUNTS = {
  Accounts: [
    { AccountID: "SIM1001", AccountType: "Margin", Status: "Active" },
    { AccountID: "SIM1002", AccountType: "Cash", Status: "Active" },
    { AccountID: "SIM1003", AccountType: "Futures", Status: "Active" },
    { AccountID: "SIM1004", AccountType: "Cash", Status: "Closed" },
    { AccountID: "SIM1005", AccountType: "DVP", Status: "Active" },
  ],
};

let calls: Call[] = [];
let responders: Record<"token" | "accounts" | "revoke", Responder>;

beforeEach(() => {
  calls = [];
  responders = {
    token: () =>
      json({
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        id_token: "id-token-SHOULD-NEVER-LEAK",
        expires_in: 1200,
        token_type: "Bearer",
      }),
    accounts: () => json(ACCOUNTS),
    revoke: () => new Response(null, { status: 200 }),
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const call: Call = {
      url,
      body: init?.body === undefined ? "" : String(init.body),
      authorization: new Headers(init?.headers).get("authorization"),
    };
    calls.push(call);
    if (url === "https://signin.tradestation.com/oauth/token") return responders.token(call);
    if (url === "https://signin.tradestation.com/oauth/revoke") return responders.revoke(call);
    if (url === "https://sim-api.tradestation.com/v3/brokerage/accounts") {
      return responders.accounts(call);
    }
    throw new Error(`unexpected request to ${url}`);
  });
});

afterEach(() => vi.restoreAllMocks());

let counter = 0;
async function newClient() {
  const userId = `conn-user-${++counter}`;
  await env.DB.prepare(
    `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Test', ?, 1, 0, 0)`,
  )
    .bind(userId, `${userId}@example.test`)
    .run();
  return { userId, stub: env.COORDINATOR.getByName(userId) };
}
type Client = Awaited<ReturnType<typeof newClient>>;

async function begin(client: Client, clientId = CLIENT_ID) {
  const result = await client.stub.beginConnection({
    mode: "SIM",
    clientId,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
  });
  if (!result.ok) throw new Error(`begin failed: ${result.code}`);
  const url = new URL(result.value.authorizeUrl);
  return { url, state: url.searchParams.get("state") ?? "" };
}

async function complete(client: Client, state: string, code = "auth-code-1") {
  const result = await client.stub.completeConnection({
    mode: "SIM",
    code,
    state,
    redirectUri: REDIRECT_URI,
  });
  await stopSyncLoop(client);
  return result;
}

async function connect(client: Client) {
  const { state } = await begin(client);
  const result = await complete(client, state);
  if (!result.ok) throw new Error(`complete failed: ${result.code}`);
  return result;
}

// Connecting arms the sync loop SYNC_INTERVAL_MS (5 s) ahead. Left alone, that real tick reconciles
// the client's Durable Object in the middle of a later test (lifting the reconciliation hold and
// restoring protection) and interleaves with the alarms these tests drive by hand. These tests
// are about the connection, not the loop (sync.test.ts covers it), so the loop is switched off.
const stopSyncLoop = (client: Client) =>
  runInDurableObject(client.stub, (_i, state) =>
    new AlarmScheduler(state.storage).schedule("sync", null),
  );

const events = (client: Client) =>
  runInDurableObject(client.stub, (_i, state) =>
    JSON.stringify(state.storage.sql.exec("SELECT * FROM events").toArray()),
  );
const storedConnections = (userId: string) =>
  env.DB.prepare("SELECT * FROM broker_connection WHERE user_id = ?").bind(userId).all();
const tokenCalls = () => calls.filter((call) => call.url.endsWith("/oauth/token"));

function expectNoSecrets(text: string) {
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

describe("beginConnection", () => {
  it("returns the TradeStation authorize URL with the audience, scopes and a fresh state", async () => {
    const client = await newClient();
    const { url, state } = await begin(client);
    expect(url.origin + url.pathname).toBe("https://signin.tradestation.com/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: CLIENT_ID,
      audience: "https://api.tradestation.com",
      redirect_uri: REDIRECT_URI,
      scope: "openid offline_access MarketData ReadAccount Trade OptionSpreads",
      state,
    });
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    expect(url.toString()).not.toContain(CLIENT_SECRET);
    expect(calls).toEqual([]);
  });

  it("stores the secret encrypted, not in the clear, and replaces an earlier attempt", async () => {
    const client = await newClient();
    const first = await begin(client);
    const second = await begin(client);
    expect(second.state).not.toBe(first.state);
    const rows = await runInDurableObject(client.stub, (_i, state) =>
      state.storage.sql.exec("SELECT * FROM oauth_attempts").toArray(),
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(CLIENT_SECRET);
    expect(rows[0]).toMatchObject({ state: second.state, client_id: CLIENT_ID });
    expect(await complete(client, first.state)).toMatchObject({ code: "STATE_INVALID" });
  });

  it("never echoes the secret and logs no secret", async () => {
    const client = await newClient();
    const result = await client.stub.beginConnection({
      mode: "SIM",
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
    });
    expect(JSON.stringify(result)).not.toContain(CLIENT_SECRET);
    expectNoSecrets(await events(client));
  });

  it("rejects malformed credentials and a malicious redirect URI", async () => {
    const client = await newClient();
    const ok = {
      mode: "SIM",
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
    };
    for (const bad of [
      { clientId: "" },
      { clientId: "has space" },
      { clientSecret: "" },
      { redirectUri: "https://evil.test/path" },
      { redirectUri: "javascript:alert(1)" },
      { userId: "someone-else" },
    ]) {
      expect(await client.stub.beginConnection({ ...ok, ...bad })).toMatchObject({
        ok: false,
        code: "INVALID_INPUT",
      });
    }
  });
});

describe("reconnecting after a failed refresh", () => {
  it("restores the connection but keeps entries blocked until reconciliation", async () => {
    const client = await newClient();
    await connect(client);
    await env.DB.prepare("UPDATE broker_connection SET status = 'REVOKED' WHERE user_id = ?")
      .bind(client.userId)
      .run();
    await runInDurableObject(client.stub, (_i, state) =>
      state.storage.kv.put("reconciliation_pending", 1),
    );
    expect(await client.stub.connection({ mode: "SIM" })).toMatchObject({
      value: { health: { status: "revoked" }, entriesBlocked: true },
    });

    const reconnected = await connect(client);
    expect(reconnected.value).toMatchObject({ health: { status: "ok" }, entriesBlocked: true });
    expect(await client.stub.connection({ mode: "SIM" })).toMatchObject({
      value: { health: { status: "ok" }, entriesBlocked: true },
    });

    const lifted = await runInDurableObject(client.stub, (_i, state) =>
      markReconciled({ storage: state.storage, db: env.DB, userId: client.userId }),
    );
    expect(lifted).toBe(true);
    expect(await client.stub.connection({ mode: "SIM" })).toMatchObject({
      value: { entriesBlocked: false },
    });
  });

  it("arms the refresh alarm once connected", async () => {
    const client = await newClient();
    await connect(client);
    const alarm = await runInDurableObject(client.stub, (_i, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
  });
});

async function seedOpenPosition(client: Client) {
  await runInDurableObject(client.stub, (_i, state) =>
    state.storage.sql.exec(
      `INSERT INTO positions (id, mode, account_id, symbol, original_qty, avg_entry_price, stop_pct,
         trailing_unlock_pct, protection_state, status, opened_on)
       VALUES ('p1', 'SIM', 'SIM1001', 'AAPL', 10, 1000000, 30, 70, 'protected', 'OPEN', '2026-10-21')`,
    ),
  );
}
const protectionOf = (client: Client) =>
  runInDurableObject(
    client.stub,
    (_i, state) =>
      state.storage.sql.exec("SELECT protection_state AS p FROM positions").one().p as string,
  );
const pendingOf = (client: Client) =>
  runInDurableObject(client.stub, (_i, state) => reconciliationPending(state.storage));
const reconcile = (client: Client) =>
  runInDurableObject(client.stub, (_i, state) =>
    markReconciled({ storage: state.storage, db: env.DB, userId: client.userId }),
  );

describe("reconciliation after the connection changes (docs/order-lifecycle.md#reconciliation)", () => {
  it("a first connect blocks entries and marks open positions unverified until markReconciled", async () => {
    const client = await newClient();
    await seedOpenPosition(client);
    expect(await pendingOf(client)).toBe(false);
    await connect(client);
    expect(await pendingOf(client)).toBe(true);
    expect(await protectionOf(client)).toBe("unverified");
    expect(await client.stub.connection({ mode: "SIM" })).toMatchObject({
      value: { entriesBlocked: true },
    });
    expect(await reconcile(client)).toBe(true);
    expect(await client.stub.connection({ mode: "SIM" })).toMatchObject({
      value: { entriesBlocked: false },
    });
  });

  it("a disconnect blocks entries and marks open positions unverified, and a reconnect alone does not lift it", async () => {
    const client = await newClient();
    await connect(client);
    expect(await reconcile(client)).toBe(true);
    await seedOpenPosition(client);
    expect(await pendingOf(client)).toBe(false);

    await client.stub.disconnect({ mode: "SIM" });
    expect(await pendingOf(client)).toBe(true);
    expect(await protectionOf(client)).toBe("unverified");

    await connect(client);
    expect(await pendingOf(client)).toBe(true);
  });

  it("a hold that lands while markReconciled waits for D1 is not lifted by it", async () => {
    const client = await newClient();
    await connect(client);
    const result = await runInDurableObject(client.stub, async (_i, state) => {
      const lifting = markReconciled({
        storage: state.storage,
        db: env.DB,
        userId: client.userId,
      });
      // Runs synchronously while the lift is awaiting D1, as a disconnect or a connect would.
      holdForReconciliation(state.storage);
      return { lifted: await lifting, pending: reconciliationPending(state.storage) };
    });
    expect(result).toEqual({ lifted: false, pending: true });
  });
});

describe("alarm", () => {
  it("refreshes ahead of expiry and arms the next one, or retries soon after a network error", async () => {
    const client = await newClient();
    await connect(client);
    // The alarm runs what is due, so make the renewal due now instead of waiting for its time.
    const run = () =>
      runInDurableObject(client.stub, async (instance, state) => {
        state.storage.kv.put("alarm_due:refresh", Date.now());
        await instance.alarm();
        // alarm() arms the real alarm for the next renewal; the test reads that time, not a firing.
        await state.storage.deleteAlarm();
      });

    await run();
    expect(tokenCalls()).toHaveLength(2); // the code exchange and the refresh
    // The renewal's own due time; the single alarm also serves the sync loop, which is sooner.
    const dueOf = () =>
      runInDurableObject(client.stub, (_i, state) =>
        state.storage.kv.get<number>("alarm_due:refresh"),
      );
    expect(await dueOf()).toBeGreaterThan(Date.now() + 10 * 60 * 1000);

    responders.token = () => new Response(null, { status: 503 });
    await run();
    expect(await dueOf()).toBeLessThan(Date.now() + 2 * 60 * 1000);
  });
});

describe("completeConnection", () => {
  it("exchanges the code, lists active Cash and Margin accounts and stores encrypted credentials", async () => {
    const client = await newClient();
    const result = await connect(client);

    expect(result.value).toEqual({
      mode: "SIM",
      status: "CONNECTED",
      health: { status: "ok" },
      entriesBlocked: true, // until the first reconciliation
      accounts: [
        { accountId: "SIM1001", accountType: "Margin" },
        { accountId: "SIM1002", accountType: "Cash" },
      ],
      refreshExpiresAt: expect.any(Number),
      lastOkAt: expect.any(Number),
    });
    expectNoSecrets(JSON.stringify(result));

    const exchange = new URLSearchParams(tokenCalls()[0]?.body);
    expect(Object.fromEntries(exchange)).toEqual({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: "auth-code-1",
      redirect_uri: REDIRECT_URI,
    });

    const rows = (await storedConnections(client.userId)).results;
    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, string | number | null>;
    expectNoSecrets(JSON.stringify(row));
    expect(row).toMatchObject({
      client_id: CLIENT_ID,
      status: "CONNECTED",
      refresh_expires_at: expect.any(Number),
    });
    // Conservative 24 h from the connect time until the SIM spike (#21) shows how the key behaves.
    expect(Number(row.refresh_expires_at)).toBe(Number(row.last_ok_at) + 24 * 60 * 60 * 1000);
    const cipher = await createCipher(env.CREDENTIALS_KEY);
    expect(row.key_id).toBe(cipher.keyId);
    expect(
      await cipher.decrypt(String(row.client_secret_enc), `${client.userId}:client_secret`),
    ).toBe(CLIENT_SECRET);
    expect(
      await cipher.decrypt(String(row.refresh_token_enc), `${client.userId}:refresh_token`),
    ).toBe(REFRESH_TOKEN);
    expectNoSecrets(await events(client));
    expect(await events(client)).toContain("broker.connected");
  });

  it("only ever talks to the SIM API for accounts and never to a live host", async () => {
    const client = await newClient();
    await connect(client);
    const hosts = calls.map((call) => new URL(call.url).host);
    expect(new Set(hosts)).toEqual(
      new Set(["signin.tradestation.com", "sim-api.tradestation.com"]),
    );
    const accounts = calls.find((call) => call.url.includes("/brokerage/accounts"));
    expect(accounts?.url.startsWith("https://sim-api.tradestation.com/v3/")).toBe(true);
    expect(accounts?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it("reports the connection and accounts afterwards, and a reconnect replaces them", async () => {
    const client = await newClient();
    await connect(client);
    expect(await client.stub.connection({ mode: "SIM" })).toMatchObject({
      ok: true,
      value: {
        status: "CONNECTED",
        accounts: [{ accountId: "SIM1001" }, { accountId: "SIM1002" }],
      },
    });
    responders.accounts = () =>
      json({ Accounts: [{ AccountID: "SIM2001", AccountType: "Cash", Status: "Active" }] });
    await connect(client);
    expect(await client.stub.connection({ mode: "SIM" })).toMatchObject({
      value: { accounts: [{ accountId: "SIM2001" }] },
    });
    expect((await storedConnections(client.userId)).results).toHaveLength(1);
  });

  it("connects with an empty account list when the key has no active Cash or Margin account", async () => {
    const client = await newClient();
    responders.accounts = () =>
      json({ Accounts: [{ AccountID: "F1", AccountType: "Futures", Status: "Active" }] });
    expect(await connect(client)).toMatchObject({ value: { status: "CONNECTED", accounts: [] } });
  });

  it("rejects a state issued to another client and does not call TradeStation", async () => {
    const alice = await newClient();
    const bob = await newClient();
    const { state } = await begin(alice);
    expect(await complete(bob, state)).toMatchObject({ ok: false, code: "STATE_INVALID" });
    expect(calls).toEqual([]);
    expect((await storedConnections(bob.userId)).results).toEqual([]);
    // Alice's own attempt is untouched by Bob's try.
    expect(await complete(alice, state)).toMatchObject({ ok: true });
  });

  it("rejects an unknown state and a missing or malformed one", async () => {
    const client = await newClient();
    await begin(client);
    expect(await complete(client, "f".repeat(64))).toMatchObject({ code: "STATE_INVALID" });
    for (const state of ["", undefined, 5]) {
      expect(
        await client.stub.completeConnection({
          mode: "SIM",
          code: "c",
          state,
          redirectUri: REDIRECT_URI,
        }),
      ).toMatchObject({ code: "INVALID_INPUT" });
    }
    expect(calls).toEqual([]);
  });

  it("rejects a reused state: the second callback never reaches TradeStation", async () => {
    const client = await newClient();
    const { state } = await begin(client);
    expect(await complete(client, state)).toMatchObject({ ok: true });
    expect(await complete(client, state, "auth-code-2")).toMatchObject({ code: "STATE_INVALID" });
    expect(tokenCalls()).toHaveLength(1);
  });

  it("lets only one of two simultaneous callbacks with the same state through", async () => {
    const client = await newClient();
    const { state } = await begin(client);
    const results = await Promise.all([complete(client, state), complete(client, state)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toMatchObject([{ code: "STATE_INVALID" }]);
    expect(tokenCalls()).toHaveLength(1);
  });

  it("rejects an expired state", async () => {
    const client = await newClient();
    const { state } = await begin(client);
    await runInDurableObject(client.stub, (_i, storage) =>
      storage.storage.sql.exec("UPDATE oauth_attempts SET expires_at = 1"),
    );
    expect(await complete(client, state)).toMatchObject({ code: "STATE_INVALID" });
    expect(calls).toEqual([]);
  });

  it("consumes the state even when the token exchange fails", async () => {
    const client = await newClient();
    const { state } = await begin(client);
    responders.token = () =>
      json({ error: "access_denied", error_description: `bad secret ${CLIENT_SECRET}` }, 401);
    const failed = await complete(client, state);
    expect(failed).toMatchObject({ ok: false, code: "TOKEN_EXCHANGE_FAILED" });
    expectNoSecrets(JSON.stringify(failed));
    expectNoSecrets(await events(client));
    expect((await storedConnections(client.userId)).results).toEqual([]);
    expect(await complete(client, state)).toMatchObject({ code: "STATE_INVALID" });
  });

  it.each([
    ["a TradeStation outage", () => new Response("down", { status: 503 }), "BROKER_UNAVAILABLE"],
    ["rate limiting", () => new Response("slow down", { status: 429 }), "BROKER_UNAVAILABLE"],
    [
      "a response without a refresh token",
      () => json({ access_token: "a", expires_in: 1 }),
      "INVALID_BROKER_RESPONSE",
    ],
    [
      "a body that is not JSON",
      () => new Response("<html>", { status: 200 }),
      "INVALID_BROKER_RESPONSE",
    ],
  ] as const)("maps %s to %s without storing anything", async (_name, respond, code) => {
    const client = await newClient();
    responders.token = respond;
    const { state } = await begin(client);
    expect(await complete(client, state)).toMatchObject({ ok: false, code });
    expect((await storedConnections(client.userId)).results).toEqual([]);
  });

  it("does not retry a failed exchange", async () => {
    const client = await newClient();
    responders.token = () => new Response("down", { status: 503 });
    const { state } = await begin(client);
    await complete(client, state);
    expect(tokenCalls()).toHaveLength(1);
  });

  it("undoes the grant when the accounts cannot be listed", async () => {
    const client = await newClient();
    responders.accounts = () => json({ Accounts: "nope" });
    const { state } = await begin(client);
    expect(await complete(client, state)).toMatchObject({ code: "INVALID_BROKER_RESPONSE" });
    expect(calls.some((call) => call.url.endsWith("/oauth/revoke"))).toBe(true);
    expect((await storedConnections(client.userId)).results).toEqual([]);
  });
});

describe("a failed reconnect", () => {
  it("drops the stored connection when revoking killed the same key's grant", async () => {
    const client = await newClient();
    await connect(client);
    responders.accounts = () => new Response("down", { status: 503 });
    const { state } = await begin(client);
    expect(await complete(client, state)).toMatchObject({ code: "BROKER_UNAVAILABLE" });
    expect((await storedConnections(client.userId)).results).toEqual([]);
    expect(await client.stub.connection({ mode: "SIM" })).toMatchObject({
      value: { status: "NOT_CONNECTED" },
    });
  });

  it("keeps the stored connection when the attempt used another key", async () => {
    const client = await newClient();
    await connect(client);
    responders.accounts = () => new Response("down", { status: 503 });
    const { state } = await begin(client, "another-client-id-0123456789");
    await complete(client, state);
    expect((await storedConnections(client.userId)).results).toHaveLength(1);
  });

  it("keeps the stored connection when the revocation did not go through", async () => {
    const client = await newClient();
    await connect(client);
    responders.accounts = () => new Response("down", { status: 503 });
    responders.revoke = () => new Response("nope", { status: 500 });
    const { state } = await begin(client);
    await complete(client, state);
    expect((await storedConnections(client.userId)).results).toHaveLength(1);
  });
});

describe("switching to another API key", () => {
  it("revokes the previous key's grant before replacing it", async () => {
    const client = await newClient();
    await connect(client);
    calls = [];
    const { state } = await begin(client, "another-client-id-0123456789");
    expect(await complete(client, state)).toMatchObject({ ok: true });
    const revokes = calls.filter((call) => call.url.endsWith("/oauth/revoke"));
    expect(revokes).toHaveLength(1);
    expect(revokes[0]?.body).toContain(CLIENT_ID);
    expect((await storedConnections(client.userId)).results).toHaveLength(1);
  });
});

describe("disconnect", () => {
  it("revokes the refresh token at TradeStation and deletes every stored credential", async () => {
    const client = await newClient();
    await connect(client);
    const result = await client.stub.disconnect({ mode: "SIM" });
    expect(result).toEqual({ ok: true, value: { revoked: true } });

    const revoke = calls.find(
      (call) => call.url === "https://signin.tradestation.com/oauth/revoke",
    );
    expect(JSON.parse(revoke?.body ?? "{}")).toMatchObject({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      token: REFRESH_TOKEN,
    });
    expect((await storedConnections(client.userId)).results).toEqual([]);
    expect(await client.stub.connection({ mode: "SIM" })).toEqual({
      ok: true,
      value: { mode: "SIM", status: "NOT_CONNECTED" },
    });
    expectNoSecrets(JSON.stringify(result) + (await events(client)));
  });

  it("deletes the credentials even when the revocation fails, and says so", async () => {
    const client = await newClient();
    await connect(client);
    responders.revoke = () => new Response("nope", { status: 500 });
    expect(await client.stub.disconnect({ mode: "SIM" })).toEqual({
      ok: true,
      value: { revoked: false },
    });
    expect((await storedConnections(client.userId)).results).toEqual([]);
  });

  it("is harmless when nothing is connected", async () => {
    const client = await newClient();
    expect(await client.stub.disconnect({ mode: "SIM" })).toEqual({
      ok: true,
      value: { revoked: false },
    });
    expect(calls).toEqual([]);
  });

  it("only touches the caller's own connection", async () => {
    const alice = await newClient();
    const bob = await newClient();
    await connect(alice);
    await connect(bob);
    await alice.stub.disconnect({ mode: "SIM" });
    expect((await storedConnections(bob.userId)).results).toHaveLength(1);
    expect(await bob.stub.connection({ mode: "SIM" })).toMatchObject({
      value: { status: "CONNECTED" },
    });
  });
});

describe("mode", () => {
  it("rejects REAL for every connection method before any IO", async () => {
    const client = await newClient();
    for (const [method, args] of [
      [
        "beginConnection",
        { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI },
      ],
      ["completeConnection", { code: "c", state: "s", redirectUri: REDIRECT_URI }],
      ["disconnect", {}],
    ] as const) {
      expect(await client.stub[method]({ ...args, mode: "REAL" })).toMatchObject({
        code: "MODE_NOT_SIM",
      });
    }
    expect(calls).toEqual([]);
  });
});

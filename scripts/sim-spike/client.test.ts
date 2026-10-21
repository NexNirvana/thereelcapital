import { describe, expect, test } from "bun:test";
import { SimClient, SpikeAbort, assertSimOrigin, orderGuard, type ClientDeps } from "./client.ts";
import { Redactor } from "./redact.ts";

const IN_SESSION = new Date("2026-10-22T15:00:00Z"); // Thursday 11:00 New York
const WEEKEND = new Date("2026-10-24T15:00:00Z");
const ACCOUNT = "SIM1234567";

interface Harness {
  client: SimClient;
  calls: { url: string; init: RequestInit }[];
  saved: { step: string; name: string; sample: unknown }[];
  redactor: Redactor;
}

function harness(overrides: Partial<ClientDeps> = {}, reply: unknown = { Accounts: [] }): Harness {
  const calls: Harness["calls"] = [];
  const saved: Harness["saved"] = [];
  const redactor = new Redactor();
  const fetchFn = ((url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(
      new Response(JSON.stringify(reply), { headers: { "x-ratelimit-remaining": "249" } }),
    );
  }) as typeof fetch;
  const client = new SimClient({
    fetchFn,
    clock: { now: () => IN_SESSION },
    redactor,
    samples: { save: (step, name, sample) => saved.push({ step, name, sample }) },
    ordersEnabled: true,
    accessToken: () => Promise.resolve("tok-secret-value"),
    ...overrides,
  });
  return { client, calls, saved, redactor };
}

const accountsReply = { Accounts: [{ AccountID: ACCOUNT, AccountType: "Cash", Status: "Active" }] };
const orderCall = {
  method: "POST",
  path: "/orderexecution/orders",
  body: { AccountID: ACCOUNT },
  accountId: ACCOUNT,
  kind: "equity",
} as const;

describe("assertSimOrigin", () => {
  test("accepts only the SIM API and the OAuth host over https", () => {
    expect(() =>
      assertSimOrigin("https://sim-api.tradestation.com/v3/brokerage/accounts"),
    ).not.toThrow();
    expect(() => assertSimOrigin("https://signin.tradestation.com/oauth/token")).not.toThrow();
  });

  test("refuses every other origin", () => {
    for (const url of [
      "https://example.com/v3/brokerage/accounts",
      "http://sim-api.tradestation.com/v3/brokerage/accounts",
      "https://sim-api.tradestation.com.evil.example/v3",
      "https://signin.tradestation.com@evil.example/oauth/token",
      "https://sim-api.tradestation.com:8443/v3",
      "not a url",
    ]) {
      expect(() => assertSimOrigin(url)).toThrow(SpikeAbort);
    }
  });
});

describe("SimClient", () => {
  test("sends reads only to the SIM host and records rate-limit headers", async () => {
    const { client, calls } = harness();
    await client.get("accounts", "accounts", "/brokerage/accounts");
    expect(calls.map((call) => new URL(call.url).origin)).toEqual([
      "https://sim-api.tradestation.com",
    ]);
    expect(client.rateLimitHeaders.get("x-ratelimit-remaining")).toBe("249");
  });

  test("refuses order paths on the read-only call", async () => {
    const { client, calls } = harness();
    await expect(client.get("s", "n", "/orderexecution/orders")).rejects.toThrow(SpikeAbort);
    expect(calls).toHaveLength(0);
  });
});

describe("order preconditions", () => {
  test("refuse without --confirm-sim-orders", async () => {
    const { client, calls } = harness({ ordersEnabled: false }, accountsReply);
    await client.loadAccounts("accounts");
    calls.length = 0;
    await expect(client.order("s", "n", orderCall)).rejects.toThrow("--confirm-sim-orders");
    expect(calls).toHaveLength(0);
  });

  test("refuse outside the regular session", async () => {
    const { client, calls } = harness({ clock: { now: () => WEEKEND } }, accountsReply);
    await client.loadAccounts("accounts");
    calls.length = 0;
    await expect(client.order("s", "n", orderCall)).rejects.toThrow("regular session");
    expect(calls).toHaveLength(0);
  });

  test("refuse an account that is not in the SIM list", async () => {
    const { client, calls } = harness({}, accountsReply);
    await client.loadAccounts("accounts");
    calls.length = 0;
    await expect(client.order("s", "n", { ...orderCall, accountId: "OTHER999" })).rejects.toThrow(
      "SIM accounts list",
    );
    expect(calls).toHaveLength(0);
  });

  test("refuse before the SIM list has been fetched", () => {
    expect(() =>
      orderGuard({
        ordersEnabled: true,
        now: IN_SESSION,
        kind: "equity",
        accountId: ACCOUNT,
        simAccounts: new Map(),
      }),
    ).toThrow(SpikeAbort);
  });

  test("send to the SIM host when every precondition holds", async () => {
    const { client, calls } = harness({}, accountsReply);
    await client.loadAccounts("accounts");
    calls.length = 0;
    await client.order("s", "n", orderCall);
    expect(calls.map((call) => call.url)).toEqual([
      "https://sim-api.tradestation.com/v3/orderexecution/orders",
    ]);
  });

  test("refuse a path outside /orderexecution/", async () => {
    const { client } = harness({}, accountsReply);
    await client.loadAccounts("accounts");
    await expect(
      client.order("s", "n", { ...orderCall, path: "/brokerage/accounts" }),
    ).rejects.toThrow(SpikeAbort);
  });
});

describe("saved samples", () => {
  test("hold no token, secret or full account number", async () => {
    const { client, saved, redactor } = harness({}, accountsReply);
    redactor.addSecret("my-client-secret");
    await client.loadAccounts("accounts");
    await client.order("s", "n", {
      ...orderCall,
      body: { AccountID: ACCOUNT, note: "my-client-secret" },
    });
    await client.token("auth", "code-exchange", {
      client_secret: "my-client-secret",
      refresh_token: "r-token-123",
    });
    const text = JSON.stringify(saved);
    for (const leaked of [ACCOUNT, "my-client-secret", "r-token-123", "tok-secret-value"]) {
      expect(text).not.toContain(leaked);
    }
    expect(text).toContain("****4567");
  });
});

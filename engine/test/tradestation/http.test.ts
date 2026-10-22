import { describe, expect, it } from "vitest";
import {
  makeTransport,
  parseRateLimit,
  type FetchFn,
  type TransportConfig,
} from "../../src/tradestation/http.ts";
import { SIM_BASE, TOKEN, failureOf, json, okToken, run, scriptedFetch } from "./helpers.ts";

function transportWith(fetchFn: FetchFn, overrides: Partial<TransportConfig> = {}) {
  const made = makeTransport({
    mode: "SIM",
    accessToken: okToken,
    fetch: fetchFn,
    retryDelayMs: 0,
    ...overrides,
  });
  if (!made.ok) throw new Error(`refused: ${made.reason}`);
  return made.transport;
}

describe("transport construction", () => {
  it("refuses REAL mode", () => {
    expect(makeTransport({ mode: "REAL", accessToken: okToken })).toEqual({
      ok: false,
      reason: "MODE_NOT_SIM",
    });
  });

  it.each([
    "https://example.com/v3",
    "http://sim-api.tradestation.com/v3",
    "https://sim-api.tradestation.com.evil.test/v3",
    "https://sim-api.tradestation.com/v3/",
    "",
  ])("refuses the base URL %j", (baseUrl) => {
    expect(makeTransport({ mode: "SIM", baseUrl, accessToken: okToken })).toEqual({
      ok: false,
      reason: "BASE_URL_NOT_SIM",
    });
  });

  it("accepts the SIM base", () => {
    expect(makeTransport({ mode: "SIM", baseUrl: SIM_BASE, accessToken: okToken }).ok).toBe(true);
  });
});

describe("transport requests", () => {
  it("sends the bearer token to the SIM host and returns the JSON body", async () => {
    const { fetch, calls } = scriptedFetch(() => json({ hello: "world" }));
    const body = await run(
      transportWith(fetch).get("accounts", "/brokerage/accounts", { a: "b c" }),
    );
    expect(body).toEqual({ hello: "world" });
    expect(calls).toEqual([
      {
        url: `${SIM_BASE}/brokerage/accounts?a=b+c`,
        method: "GET",
        body: null,
        authorization: `Bearer ${TOKEN}`,
      },
    ]);
  });

  it("fails with AuthExpired without sending when there is no usable token", async () => {
    const { fetch, calls } = scriptedFetch(() => json({}));
    const transport = transportWith(fetch, { accessToken: async () => ({ ok: false }) });
    expect(await failureOf(transport.get("positions", "/x"))).toMatchObject({
      _tag: "AuthExpired",
      operation: "positions",
    });
    expect(calls).toHaveLength(0);
  });

  it("maps 401 to AuthExpired", async () => {
    const { fetch } = scriptedFetch(() => json({ Error: "Unauthorized" }, 401));
    expect(await failureOf(transportWith(fetch).get("accounts", "/x"))).toMatchObject({
      _tag: "AuthExpired",
    });
  });

  it("maps 429 to RateLimited with the reset time and records the headers", async () => {
    const { fetch } = scriptedFetch(() =>
      json({ Error: "TooManyRequests", Message: "Rate quota exceeded" }, 429, {
        "x-ratelimit-limit": "250",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-period": "300",
        "x-ratelimit-reset": "287",
        "x-ratelimit-resource": "brokerage",
      }),
    );
    const transport = transportWith(fetch);
    expect(await failureOf(transport.get("orders", "/x"))).toMatchObject({
      _tag: "RateLimited",
      retryAfterMs: 287_000,
      rateLimit: {
        resource: "brokerage",
        limit: 250,
        remaining: 0,
        periodSeconds: 300,
        resetMs: 287_000,
      },
    });
    expect(transport.rateLimit()).toEqual({
      resource: "brokerage",
      limit: 250,
      remaining: 0,
      periodSeconds: 300,
      resetMs: 287_000,
    });
  });

  it("gives a null retry hint when 429 carries no headers", async () => {
    const { fetch } = scriptedFetch(() => json({}, 429));
    expect(await failureOf(transportWith(fetch).get("orders", "/x"))).toMatchObject({
      _tag: "RateLimited",
      retryAfterMs: null,
    });
  });

  it("reads the rate-limit headers of successful responses too", async () => {
    const { fetch } = scriptedFetch(() => json({}, 200, { "x-ratelimit-remaining": "41" }));
    const transport = transportWith(fetch);
    await run(transport.get("orders", "/x"));
    expect(transport.rateLimit()).toMatchObject({ remaining: 41, limit: null });
  });

  it("maps other 4xx to Rejected with the broker's code and a short reason", async () => {
    const { fetch } = scriptedFetch(() =>
      json({ Error: "BadRequest", Message: "x".repeat(500) }, 400),
    );
    const error = await failureOf(transportWith(fetch).send("placeOrder", "POST", "/x", {}));
    expect(error).toMatchObject({ _tag: "Rejected", code: "BadRequest" });
    expect(error._tag === "Rejected" && error.reason.length).toBe(200);
  });

  it("maps the missing-scope 403 to a stable MISSING_SCOPE code", async () => {
    const { fetch } = scriptedFetch(() =>
      json({ Message: "Missing required scope.", StatusCode: 403, TraceID: "trace" }, 403),
    );
    expect(await failureOf(transportWith(fetch).get("optionExpirations", "/x"))).toMatchObject({
      _tag: "Rejected",
      code: "MISSING_SCOPE",
      reason: "Missing required scope.",
    });
  });

  it("keeps other 403 refusals under their own code", async () => {
    const { fetch } = scriptedFetch(() => json({ Error: "Forbidden", Message: "no" }, 403));
    expect(await failureOf(transportWith(fetch).get("quotes", "/x"))).toMatchObject({
      code: "Forbidden",
    });
  });

  it("falls back to an HTTP code when the 4xx body is not the documented shape", async () => {
    const { fetch } = scriptedFetch(() => new Response("<html>", { status: 404 }));
    expect(await failureOf(transportWith(fetch).get("quotes", "/x"))).toMatchObject({
      _tag: "Rejected",
      code: "HTTP_404",
      reason: "",
    });
  });

  it("maps an aborted request to Timeout", async () => {
    const { fetch } = scriptedFetch(() => {
      throw new DOMException("", "TimeoutError");
    });
    expect(
      await failureOf(transportWith(fetch).send("placeOrder", "POST", "/x", {})),
    ).toMatchObject({
      _tag: "Timeout",
      operation: "placeOrder",
    });
  });

  it("times out a response that never arrives", async () => {
    const hang: FetchFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const transport = transportWith(hang, { timeoutMs: 20 });
    expect(await failureOf(transport.send("cancelOrder", "DELETE", "/x"))).toMatchObject({
      _tag: "Timeout",
    });
  });

  it("maps a 5xx, a dropped connection and a bad body to Unknown", async () => {
    const five = scriptedFetch(() => json({}, 503));
    expect(
      await failureOf(transportWith(five.fetch).send("placeOrder", "POST", "/x", {})),
    ).toMatchObject({
      _tag: "Unknown",
    });
    const dropped = scriptedFetch(() => {
      throw new TypeError("connection reset");
    });
    expect(
      await failureOf(transportWith(dropped.fetch).send("placeOrder", "POST", "/x", {})),
    ).toMatchObject({ _tag: "Unknown", detail: "network" });
    const garbage = scriptedFetch(() => new Response("not json", { status: 200 }));
    expect(await failureOf(transportWith(garbage.fetch).get("accounts", "/x"))).toMatchObject({
      _tag: "Unknown",
      detail: "invalid_response",
    });
  });

  it("treats a body cut off mid-read as a dropped connection and retries the read", async () => {
    const cut = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError("connection reset"));
          },
        }),
      );
    const { fetch, calls } = scriptedFetch(cut, () => json({ ok: 1 }));
    expect(await run(transportWith(fetch).get("accounts", "/x"))).toEqual({ ok: 1 });
    expect(calls).toHaveLength(2);
    const always = scriptedFetch(cut);
    expect(
      await failureOf(transportWith(always.fetch).send("placeOrder", "POST", "/x", {})),
    ).toMatchObject({
      _tag: "Unknown",
      detail: "network",
    });
  });

  it("never echoes the token in an error", async () => {
    const { fetch } = scriptedFetch(() => json({ Error: "Forbidden", Message: "no" }, 403));
    const error = await failureOf(transportWith(fetch).get("accounts", "/x"));
    expect(JSON.stringify(error)).not.toContain(TOKEN);
  });
});

describe("retries", () => {
  it("retries an idempotent read after a 5xx, at most twice", async () => {
    const { fetch, calls } = scriptedFetch(() => json({}, 503));
    expect(await failureOf(transportWith(fetch).get("accounts", "/x"))).toMatchObject({
      _tag: "Unknown",
    });
    expect(calls).toHaveLength(3);
  });

  it("returns the first good answer after a transient failure", async () => {
    const { fetch, calls } = scriptedFetch(
      () => json({}, 504),
      () => json({ ok: 1 }),
    );
    expect(await run(transportWith(fetch).get("accounts", "/x"))).toEqual({ ok: 1 });
    expect(calls).toHaveLength(2);
  });

  it("does not retry a read that was refused, rate limited or unauthorized", async () => {
    for (const status of [400, 401, 429]) {
      const { fetch, calls } = scriptedFetch(() => json({}, status));
      await failureOf(transportWith(fetch).get("accounts", "/x"));
      expect(calls).toHaveLength(1);
    }
  });

  it.each([
    ["a 5xx", () => json({}, 503)],
    [
      "a dropped connection",
      () => {
        throw new TypeError("reset");
      },
    ],
    [
      "a timeout",
      () => {
        throw new DOMException("", "TimeoutError");
      },
    ],
  ])("never retries a send after %s", async (_name, respond) => {
    const { fetch, calls } = scriptedFetch(respond);
    await failureOf(transportWith(fetch).send("placeOrder", "POST", "/x", {}));
    expect(calls).toHaveLength(1);
  });
});

describe("parseRateLimit", () => {
  it("is null without any X-RateLimit header", () => {
    expect(parseRateLimit(new Headers())).toBeNull();
  });
  it("ignores values that are not whole numbers", () => {
    expect(
      parseRateLimit(new Headers({ "x-ratelimit-reset": "soon", "x-ratelimit-limit": "9" })),
    ).toMatchObject({
      limit: 9,
      resetMs: null,
    });
  });
});

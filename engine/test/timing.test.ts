import { afterEach, describe, expect, it, vi } from "vitest";
import { logColo, timedD1 } from "../src/timing.ts";
import { makeTransport } from "../src/tradestation/http.ts";
import { failureOf, json, okToken, run, scriptedFetch } from "./tradestation/helpers.ts";

const lines = (spy: { mock: { calls: unknown[][] } }): string[] =>
  spy.mock.calls.map((c) => String(c[0]));

afterEach(() => vi.restoreAllMocks());

function transportOver(fetchFn: Parameters<typeof makeTransport>[0]["fetch"]) {
  const made = makeTransport({
    mode: "SIM",
    accessToken: okToken,
    fetch: fetchFn,
    retryDelayMs: 0,
  });
  if (!made.ok) throw new Error("refused");
  return made.transport;
}

describe("broker.request events", () => {
  it("logs the operation, status and ms, and nothing of the URL, query or body", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { fetch } = scriptedFetch(
      () => json({ ok: 1 }),
      () => json({ ok: 1 }),
    );
    const transport = transportOver(fetch);
    await run(transport.get("quotes", "/marketdata/quotes/AAPL,TSLA", { accountid: "SIM123456" }));
    await run(transport.send("placeOrder", "POST", "/orderexecution/orders", { Symbol: "AAPL" }));
    const out = lines(log);
    expect(out.map((l) => Object.keys(JSON.parse(l) as object))).toEqual([
      ["event", "operation", "status", "ms"],
      ["event", "operation", "status", "ms"],
    ]);
    expect(JSON.parse(out[0] ?? "")).toMatchObject({
      event: "broker.request",
      operation: "quotes",
      status: 200,
    });
    const all = out.join("\n");
    for (const secret of ["AAPL", "TSLA", "SIM123456", "accountid", "marketdata", "access-token"]) {
      expect(all).not.toContain(secret);
    }
  });

  it("logs a null status when no response arrived, and the error status otherwise", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { fetch } = scriptedFetch(
      () => json({}, 429),
      () => Promise.reject(new TypeError("x")),
    );
    const transport = transportOver(fetch);
    await failureOf(transport.send("cancelOrder", "DELETE", "/orderexecution/orders/1", undefined));
    await failureOf(transport.send("orders", "POST", "/x", undefined));
    const events = lines(log).map((l) => JSON.parse(l) as { status: number | null });
    expect(events.map((e) => e.status)).toEqual([429, null]);
  });
});

describe("d1.query events", () => {
  it("logs the fixed name and ms, and passes the result or the error through", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await timedD1("size_usd", Promise.resolve(7))).toBe(7);
    await expect(timedD1("token_row", Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    const events = lines(log).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.map((e) => [e.event, e.name, typeof e.ms])).toEqual([
      ["d1.query", "size_usd", "number"],
      ["d1.query", "token_row", "number"],
    ]);
  });
});

describe("do.colo event", () => {
  it("logs only the colo line of the trace", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const trace = "fl=1\nip=203.0.113.9\nuag=Mozilla\ncolo=IAD\nloc=US\n";
    await logColo(async () => new Response(trace));
    expect(lines(log)).toEqual(['{"event":"do.colo","colo":"IAD"}']);
  });

  it("stays silent when the trace fails or has no colo", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await logColo(() => Promise.reject(new Error("offline")));
    await logColo(async () => new Response("fl=1\n"));
    expect(log).not.toHaveBeenCalled();
  });
});

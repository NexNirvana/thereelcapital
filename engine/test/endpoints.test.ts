import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LIVE_API_BASE_URL,
  SIM_API_BASE_URL,
  apiBaseUrlFor,
  isAllowedOrigin,
  send,
  type ApiGate,
} from "../src/tradestation/endpoints.ts";

afterEach(() => vi.restoreAllMocks());

const SIM: ApiGate = { mode: "SIM", realTrading: false };
const REAL_CLOSED: ApiGate = { mode: "REAL", realTrading: false };
const REAL_OPEN: ApiGate = { mode: "REAL", realTrading: true };
const AUTH_URL = "https://signin.tradestation.com/oauth/token";

describe("apiBaseUrlFor", () => {
  it("is the mode's own base", () => {
    expect(apiBaseUrlFor("SIM")).toBe(SIM_API_BASE_URL);
    expect(apiBaseUrlFor("REAL")).toBe(LIVE_API_BASE_URL);
  });
});

describe("send origin guard", () => {
  it.each([`${SIM_API_BASE_URL}/brokerage/accounts`, AUTH_URL])("allows %s in SIM", (url) => {
    expect(isAllowedOrigin(url)).toBe(true);
    expect(isAllowedOrigin(url, SIM)).toBe(true);
  });

  it("allows the live origin only for REAL with the switch open", () => {
    const url = `${LIVE_API_BASE_URL}/brokerage/accounts`;
    expect(isAllowedOrigin(url, REAL_OPEN)).toBe(true);
    expect(isAllowedOrigin(url, REAL_CLOSED)).toBe(false);
    expect(isAllowedOrigin(url, SIM)).toBe(false);
    expect(isAllowedOrigin(url, { mode: "SIM", realTrading: true })).toBe(false);
    expect(isAllowedOrigin(url)).toBe(false);
  });

  it("keeps SIM out of REAL, and the auth tenant open to a closed REAL gate", () => {
    expect(isAllowedOrigin(`${SIM_API_BASE_URL}/brokerage/accounts`, REAL_OPEN)).toBe(false);
    expect(isAllowedOrigin(`${SIM_API_BASE_URL}/brokerage/accounts`, REAL_CLOSED)).toBe(false);
    expect(isAllowedOrigin(AUTH_URL, REAL_OPEN)).toBe(true);
  });

  it.each([
    ["https://example.com/v3", SIM],
    ["https://example.com/v3", REAL_OPEN],
    ["http://sim-api.tradestation.com/v3", SIM],
    ["https://sim-api.tradestation.com.evil.test/v3", SIM],
    ["https://sim-api.tradestation.com@evil.test/v3", SIM],
    ["https://sim-api.tradestation.com:8443/v3", SIM],
    ["//sim-api.tradestation.com/v3", SIM],
    [`${LIVE_API_BASE_URL.replace("https:", "http:")}`, REAL_OPEN],
    [`${LIVE_API_BASE_URL.replace("https://", "https://x.")}`, REAL_OPEN],
    ["not a url", SIM],
    ["", REAL_OPEN],
  ] as const)("refuses %j without sending a request", async (url, gate) => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect(isAllowedOrigin(url, gate)).toBe(false);
    expect(await send("accounts", url, {}, gate)).toEqual({ ok: false, failure: "REJECTED" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("sends a closed REAL request nowhere", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const url = `${LIVE_API_BASE_URL}/brokerage/accounts`;
    expect(await send("accounts", url, {}, REAL_CLOSED)).toEqual({
      ok: false,
      failure: "REJECTED",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("sends a REAL request to the live origin only through a scripted fetch", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const url = `${LIVE_API_BASE_URL}/brokerage/accounts`;
    expect(await send("accounts", url, {}, REAL_OPEN)).toMatchObject({ ok: true });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0])).toBe(url);
  });
});

describe("the test setup's live-origin guard", () => {
  it("throws on an unscripted fetch to the live origin", async () => {
    await expect(fetch(`${LIVE_API_BASE_URL}/brokerage/accounts`)).rejects.toThrow(/live origin/);
    await expect(fetch(new Request(`${LIVE_API_BASE_URL}/x`))).rejects.toThrow(/live origin/);
    await expect(fetch(new URL(`${LIVE_API_BASE_URL}/x`))).rejects.toThrow(/live origin/);
    await expect(fetch(LIVE_API_BASE_URL.replace("https:", "http:"))).rejects.toThrow(
      /live origin/,
    );
    await expect(fetch(LIVE_API_BASE_URL.replace("/v3", ":8443/v3"))).rejects.toThrow(
      /live origin/,
    );
  });
});

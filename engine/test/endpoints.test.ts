import { afterEach, describe, expect, it, vi } from "vitest";
import { isAllowedOrigin, send } from "../src/tradestation/endpoints.ts";

afterEach(() => vi.restoreAllMocks());

describe("send origin guard", () => {
  it.each([
    "https://sim-api.tradestation.com/v3/brokerage/accounts",
    "https://signin.tradestation.com/oauth/token",
  ])("allows %s", (url) => {
    expect(isAllowedOrigin(url)).toBe(true);
  });

  it.each([
    "https://example.com/v3",
    "http://sim-api.tradestation.com/v3",
    "https://sim-api.tradestation.com.evil.test/v3",
    "https://sim-api.tradestation.com@evil.test/v3",
    "https://sim-api.tradestation.com:8443/v3",
    "//sim-api.tradestation.com/v3",
    "not a url",
    "",
  ])("refuses %j without sending a request", async (url) => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect(isAllowedOrigin(url)).toBe(false);
    expect(await send("auth", url, {})).toEqual({ ok: false, failure: "REJECTED" });
    expect(spy).not.toHaveBeenCalled();
  });
});

// Test setup: no test may reach the live TradeStation host (CLAUDE.md, no real money). Any `fetch`
// to its host (any scheme or port) throws unless the test scripted it, either by injecting a `FetchFn` into the
// transport or by replacing `globalThis.fetch` itself (`vi.spyOn`), which sits above this guard.
import { vi } from "vitest";
import { LIVE_API_BASE_URL } from "../src/tradestation/endpoints.ts";

const LIVE_HOST = new URL(LIVE_API_BASE_URL).hostname;
const realFetch = globalThis.fetch.bind(globalThis);

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = urlOf(input);
  if (URL.canParse(url) && new URL(url).hostname === LIVE_HOST) {
    throw new Error("unscripted fetch to the live origin refused by the test setup");
  }
  return realFetch(input, init);
});

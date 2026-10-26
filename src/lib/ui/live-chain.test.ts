import { expect, test } from "bun:test";
import { chainWithUnderlying, parseLiveChain, readLiveChain } from "./live-chain.ts";

const side = { symbol: "MSFT 261120C400", bid: 1_000_000, ask: 1_100_000 };
const ready = {
  status: "ready",
  chain: { receivedAt: 5, strikes: [{ strike: 400_000_000, call: side, put: null }] },
};

test("reads a chain and keeps a side without a market as null, never zero", () => {
  expect(parseLiveChain(ready)).toEqual(ready.chain as never);
});

test("refuses anything that is not the endpoint's shape", () => {
  for (const body of [
    null,
    "x",
    {},
    { status: "unavailable" },
    { status: "ready" },
    { status: "ready", chain: { receivedAt: 5 } },
    { status: "ready", chain: { receivedAt: "5", strikes: [] } },
    { status: "ready", chain: { receivedAt: 5, strikes: [{ strike: 1, call: {}, put: null }] } },
    { status: "ready", chain: { receivedAt: 5, strikes: [{ strike: 1, call: side }] } },
    { status: "ready", chain: { receivedAt: 5, strikes: [null] } },
  ]) {
    expect(parseLiveChain(body)).toBeNull();
  }
});

test("an error status, a network failure and a malformed body are all no update", async () => {
  const answer = (init: ResponseInit, body: string) =>
    (async () => new Response(body, init)) as unknown as typeof fetch;
  expect(await readLiveChain("/x", answer({ status: 502 }, "{}"))).toBeNull();
  expect(await readLiveChain("/x", answer({ status: 200 }, "not json"))).toBeNull();
  expect(
    await readLiveChain("/x", (async () => Promise.reject(new Error("down"))) as never),
  ).toBeNull();
  expect(await readLiveChain("/x", answer({ status: 200 }, JSON.stringify(ready)))).toEqual(
    ready.chain as never,
  );
});

test("a quote message updates the contract on screen, and a missing side shows as no market", async () => {
  const { chainFromMessage, chainSymbols } = await import("./live-chain.ts");
  const chain = {
    receivedAt: 5,
    strikes: [
      { strike: 400_000_000, call: side, put: { symbol: "MSFT 261120P400", bid: 1, ask: 2 } },
    ],
  };
  expect(chainSymbols(chain)).toEqual(["MSFT 261120C400", "MSFT 261120P400"]);
  const moved = chainFromMessage(
    chain,
    {
      type: "quote",
      symbol: "MSFT 261120C400",
      bid: 2_000_000,
      ask: 2_100_000,
      receivedAt: 8,
    },
    chain,
  );
  expect(moved?.receivedAt).toBe(8);
  expect(moved?.strikes[0]?.call).toEqual({
    symbol: "MSFT 261120C400",
    bid: 2_000_000,
    ask: 2_100_000,
  });
  expect(moved?.strikes[0]?.put).toEqual(chain.strikes[0]?.put as never);
  const noAsk = chainFromMessage(
    chain,
    {
      type: "quote",
      symbol: "MSFT 261120P400",
      bid: 1,
      ask: null,
      receivedAt: 9,
    },
    chain,
  );
  expect(noAsk?.strikes[0]?.put).toBeNull();
  expect(chainFromMessage(chain, { type: "alive", receivedAt: 6 }, chain)?.receivedAt).toBe(6);
  expect(chainFromMessage(chain, { type: "state", state: "live" }, chain)).toBeNull();
});

test("a side that lost its market comes back when its quote does", async () => {
  const { chainFromMessage } = await import("./live-chain.ts");
  const reference = { receivedAt: 5, strikes: [{ strike: 400_000_000, call: side, put: null }] };
  const shown = { receivedAt: 6, strikes: [{ strike: 400_000_000, call: null, put: null }] };
  const back = chainFromMessage(
    shown,
    { type: "quote", symbol: side.symbol, bid: 1, ask: 2, receivedAt: 7 },
    reference,
  );
  expect(back?.strikes[0]?.call).toEqual({ symbol: side.symbol, bid: 1, ask: 2 });
});

test("the underlying's tick moves the price to the middle of its bid and ask", () => {
  const chain = { receivedAt: 1, underlyingPrice: 100_000_000, strikes: [] };
  const quote = (symbol: string, bid: number | null, ask: number | null) =>
    ({ type: "quote", symbol, bid, ask, receivedAt: 5 }) as const;
  expect(chainWithUnderlying(chain, quote("MSFT", 101_000_000, 102_000_000), "MSFT")).toEqual({
    receivedAt: 5,
    underlyingPrice: 101_500_000,
    strikes: [],
  });
  // Another symbol, a one-sided market and other messages leave the price alone.
  expect(chainWithUnderlying(chain, quote("MSFT 261030C400", 1, 2), "MSFT")).toBeNull();
  expect(chainWithUnderlying(chain, quote("MSFT", null, 102_000_000), "MSFT")).toBeNull();
  expect(chainWithUnderlying(chain, { type: "alive", receivedAt: 6 }, "MSFT")).toBeNull();
});

test("a chain answer carries the underlying price when it has one", () => {
  const body = (chain: object) => ({ status: "ready", chain });
  expect(parseLiveChain(body({ receivedAt: 1, underlyingPrice: 5, strikes: [] }))).toEqual({
    receivedAt: 1,
    underlyingPrice: 5,
    strikes: [],
  });
  expect(parseLiveChain(body({ receivedAt: 1, strikes: [] }))?.underlyingPrice).toBeUndefined();
});

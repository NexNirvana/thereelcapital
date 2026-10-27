import { expect, test } from "bun:test";
import {
  chainFromMessages,
  indexChain,
  parseLiveChain,
  readLiveChain,
  type LiveChain,
} from "./live-chain.ts";
import type { LiveMessage } from "#lib/domain/live-protocol.ts";

// One message applied to a chain, as the screen does for each tick of a frame.
const chainFromMessage = (chain: LiveChain, message: LiveMessage, reference: LiveChain) =>
  chainFromMessages(chain, [message], indexChain(reference), "");

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
  const { chainSymbols } = await import("./live-chain.ts");
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
  const chain: LiveChain = { receivedAt: 1, underlyingPrice: 100_000_000, strikes: [] };
  const quote = (symbol: string, bid: number | null, ask: number | null) =>
    ({ type: "quote", symbol, bid, ask, receivedAt: 5 }) as const;
  const apply = (message: LiveMessage) =>
    chainFromMessages(chain, [message], indexChain(chain), "MSFT");
  expect(apply(quote("MSFT", 101_000_000, 102_000_000))).toEqual({
    receivedAt: 5,
    underlyingPrice: 101_500_000,
    strikes: [],
  });
  // Another symbol and a one-sided market leave the price alone (the time still moves).
  expect(apply(quote("MSFT 261030C400", 1, 2))?.underlyingPrice).toBe(100_000_000);
  expect(apply(quote("MSFT", null, 102_000_000))).toEqual({ ...chain, receivedAt: 5 });
  // A message that is not a quote or a heartbeat is no update.
  expect(apply({ type: "state", state: "live" })).toBeNull();
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

test("a run of ticks updates only the rows it names, the last tick of a symbol wins and untouched rows are the same objects", () => {
  const row = (strike: number) => ({
    strike,
    call: { symbol: `C${strike}`, bid: 1, ask: 2 },
    put: { symbol: `P${strike}`, bid: 1, ask: 2 },
  });
  const chain: LiveChain = {
    receivedAt: 1,
    underlyingPrice: 50,
    strikes: [row(1), row(2), row(3)],
  };
  const quote = (symbol: string, bid: number | null, ask: number | null, receivedAt: number) =>
    ({ type: "quote", symbol, bid, ask, receivedAt }) as const;
  const next = chainFromMessages(
    chain,
    [
      quote("C2", 5, 6, 10),
      quote("P3", 7, 8, 11),
      quote("C2", 9, 10, 12),
      { type: "alive", receivedAt: 13 },
      quote("UNDER", 100, 102, 14),
      quote("OTHER", 1, 2, 15),
    ],
    indexChain(chain),
    "UNDER",
  );
  expect(next?.receivedAt).toBe(15);
  expect(next?.underlyingPrice).toBe(101);
  expect(next?.strikes[1]?.call).toEqual({ symbol: "C2", bid: 9, ask: 10 });
  expect(next?.strikes[2]?.put).toEqual({ symbol: "P3", bid: 7, ask: 8 });
  expect(next?.strikes[0]).toBe(chain.strikes[0]!);
  expect(next?.strikes[1]?.put).toBe(chain.strikes[1]!.put!);
  // The chain it started from is left alone.
  expect(chain.strikes[1]?.call).toEqual({ symbol: "C2", bid: 1, ask: 2 });
  expect(chainFromMessages(chain, [], indexChain(chain), "UNDER")).toBeNull();
  expect(
    chainFromMessages(chain, [{ type: "state", state: "live" }], indexChain(chain), "UNDER"),
  ).toBeNull();
});

test("a tick for a contract that is not in the chain only refreshes the time and keeps the rows", () => {
  const chain: LiveChain = { receivedAt: 1, strikes: [] };
  const next = chainFromMessages(
    chain,
    [{ type: "quote", symbol: "X", bid: 1, ask: 2, receivedAt: 9 }],
    indexChain(chain),
    "U",
  );
  expect(next).toEqual({ receivedAt: 9, strikes: [] });
  expect(next?.strikes).toBe(chain.strikes);
});

import { expect, test } from "bun:test";
import { parseLiveChain, readLiveChain } from "./live-chain.ts";

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

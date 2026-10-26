import { expect, test } from "bun:test";
import { parseLiveEntry, readLiveEntry } from "./live-entry.ts";

const ready = {
  status: "ready",
  preview: {
    symbol: "SPY",
    qty: 50,
    sizeMicros: 20_000_000_000,
    askMicros: 400_000_000,
    assetType: "equity",
  },
  receivedAt: 1_000,
};

test("reads a ready answer and a blocked one", () => {
  expect(parseLiveEntry(ready)).toEqual(ready as never);
  expect(parseLiveEntry({ status: "blocked", message: "El mercado está cerrado." })).toEqual({
    status: "blocked",
    message: "El mercado está cerrado.",
  });
});

test("refuses anything that is not the endpoint's shape", () => {
  for (const body of [
    null,
    "x",
    {},
    { status: "unavailable" },
    { status: "blocked" },
    { status: "ready", receivedAt: 1 },
    { ...ready, preview: { ...ready.preview, askMicros: "4" } },
    { ...ready, preview: { ...ready.preview, assetType: "future" } },
    { ...ready, receivedAt: Number.NaN },
  ]) {
    expect(parseLiveEntry(body)).toBeNull();
  }
});

test("an error status, a network failure and a malformed body are all no update", async () => {
  const answer = (init: ResponseInit, body = "{}") =>
    (async () => new Response(body, init)) as unknown as typeof fetch;
  expect(await readLiveEntry("/x", answer({ status: 502 }))).toBeNull();
  expect(await readLiveEntry("/x", answer({ status: 200 }, "nope"))).toBeNull();
  expect(
    await readLiveEntry("/x", (async () => Promise.reject(new Error("down"))) as never),
  ).toBeNull();
  expect(await readLiveEntry("/x", answer({ status: 200 }, JSON.stringify(ready)))).toEqual(
    ready as never,
  );
});

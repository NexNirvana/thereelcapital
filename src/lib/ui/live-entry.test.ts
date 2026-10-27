import { expect, test } from "bun:test";
import {
  matchingChoice,
  parseLiveEntry,
  readLiveEntry,
  SIZE_CHOICE_MISMATCH,
} from "./live-entry.ts";

const ready = {
  status: "ready",
  preview: {
    symbol: "SPY",
    qty: 50,
    sizeMicros: 20_000_000_000,
    sizeChoice: "full",
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

test("an entry message becomes what the screen shows, and a heartbeat only refreshes its time", async () => {
  const { entryFromMessage } = await import("./live-entry.ts");
  const ready = entryFromMessage(
    {
      type: "entry",
      update: {
        status: "ready",
        symbol: "A",
        assetType: "equity",
        qty: 2,
        sizeMicros: 10,
        sizeChoice: "full",
        askMicros: 5,
      },
      receivedAt: 7,
    },
    null,
  );
  expect(ready).toEqual({
    status: "ready",
    preview: {
      symbol: "A",
      qty: 2,
      sizeMicros: 10,
      sizeChoice: "full",
      askMicros: 5,
      assetType: "equity",
    },
    receivedAt: 7,
  });
  expect(entryFromMessage({ type: "alive", receivedAt: 9 }, ready)).toMatchObject({
    receivedAt: 9,
  });
  expect(entryFromMessage({ type: "alive", receivedAt: 9 }, null)).toBeNull();
  expect(entryFromMessage({ type: "state", state: "live" }, ready)).toBeNull();
  const blocked = entryFromMessage(
    { type: "entry", update: { status: "blocked", reasons: ["NO_ASK"] }, receivedAt: 7 },
    ready,
  );
  expect(blocked?.status).toBe("blocked");
});

test("an endpoint answer without a choice is the full SIZE; an unknown choice is no answer", () => {
  const bare: Record<string, unknown> = { ...ready.preview };
  delete bare.sizeChoice;
  expect(parseLiveEntry({ ...ready, preview: bare })).toEqual(ready as never);
  expect(parseLiveEntry({ ...ready, preview: { ...bare, sizeChoice: "down50" } })).toBeNull();
  expect(parseLiveEntry({ ...ready, preview: { ...bare, sizeChoice: "down25" } })).toMatchObject({
    preview: { sizeChoice: "down25" },
  });
});

// Deploy skew: an engine that predates the choice ignores it and sizes at the full SIZE, so the
// quantity on screen would not be the one a reduced order sends.
test("an answer for another SIZE choice than the one requested is never shown", () => {
  const full = parseLiveEntry(ready);
  const reduced = parseLiveEntry({ ...ready, preview: { ...ready.preview, sizeChoice: "down25" } });
  if (full === null || reduced === null) throw new Error("fixture must parse");
  expect(matchingChoice(full, "full")).toBe(full);
  expect(matchingChoice(reduced, "down25")).toBe(reduced);
  expect(matchingChoice(full, "down25")).toEqual({
    status: "blocked",
    message: SIZE_CHOICE_MISMATCH,
  });
  expect(matchingChoice(reduced, "full")).toMatchObject({ status: "blocked" });
  const blocked = { status: "blocked", message: "x" } as const;
  expect(matchingChoice(blocked, "down25")).toBe(blocked);
});

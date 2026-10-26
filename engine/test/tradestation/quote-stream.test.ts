import { describe, expect, it, vi } from "vitest";
import type { QuoteStreamEvent } from "../../src/broker/adapter.ts";
import { LIVE_STREAM_IDLE_MS } from "#lib/domain/config.ts";
import { makeTransport, type FetchFn } from "../../src/tradestation/http.ts";
import { quoteStream } from "../../src/tradestation/quote-stream.ts";
import { SIM_BASE, TOKEN, failureOf, json, okToken, run, scriptedFetch } from "./helpers.ts";

function transportWith(fetchFn: FetchFn) {
  const made = makeTransport({ mode: "SIM", accessToken: okToken, fetch: fetchFn });
  if (!made.ok) throw new Error(`refused: ${made.reason}`);
  return made.transport;
}

/** A body that delivers `chunks` and then stays open until `end()` or the request is aborted. */
function openBody(chunks: string[]) {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      for (const chunk of chunks) c.enqueue(encoder.encode(chunk));
    },
  });
  return { body, end: () => controller?.close() };
}

describe("quoteStream", () => {
  it("reads quotes split across chunks from the SIM stream path, with the token", async () => {
    const { body, end } = openBody([
      '{"Symbol":"AAPL","Bid":"10","As',
      'k":"11"}\r\n{"Heartbeat":1}\r\n{"Symbol":"AAPL","Ask":"12"}',
    ]);
    const scripted = scriptedFetch(() => new Response(body, { status: 200 }));
    const events: QuoteStreamEvent[] = [];
    const controller = new AbortController();
    const finished = run(
      quoteStream(
        transportWith(scripted.fetch),
        ["AAPL", "MSFT"],
        () => 9,
        (event) => {
          events.push(event);
          if (events.length === 3) end();
        },
        controller.signal,
      ),
    );
    await finished;
    expect(scripted.calls[0]).toMatchObject({
      url: `${SIM_BASE}/marketdata/stream/quotes/AAPL,MSFT`,
      method: "GET",
      authorization: `Bearer ${TOKEN}`,
    });
    expect(events.map((e) => e.kind)).toEqual(["quote", "heartbeat", "quote"]);
    expect(events[2]).toMatchObject({ quote: { bid: 10_000_000, ask: 12_000_000 } });
  });

  it("ends normally when the caller aborts", async () => {
    const { body } = openBody(['{"Heartbeat":1}']);
    const scripted = scriptedFetch(() => new Response(body, { status: 200 }));
    const controller = new AbortController();
    await run(
      quoteStream(
        transportWith(scripted.fetch),
        ["AAPL"],
        () => 1,
        () => controller.abort(),
        controller.signal,
      ),
    );
    expect(controller.signal.aborted).toBe(true);
  });

  it("fails on DualLogon so the caller reconnects", async () => {
    const { body } = openBody(['{"Symbol":"AAPL","Error":"DualLogon"}']);
    const scripted = scriptedFetch(() => new Response(body, { status: 200 }));
    const error = await failureOf(
      quoteStream(
        transportWith(scripted.fetch),
        ["AAPL"],
        () => 1,
        () => undefined,
        new AbortController().signal,
      ),
    );
    expect(error).toMatchObject({ _tag: "Rejected", code: "DualLogon" });
  });

  it("fails when the stream goes silent, so the hub restarts it", async () => {
    vi.useFakeTimers();
    try {
      const { body } = openBody(['{"Heartbeat":1}']);
      const scripted = scriptedFetch(() => new Response(body, { status: 200 }));
      const failure = failureOf(
        quoteStream(
          transportWith(scripted.fetch),
          ["AAPL"],
          () => 1,
          () => undefined,
          new AbortController().signal,
        ),
      );
      await vi.advanceTimersByTimeAsync(LIVE_STREAM_IDLE_MS + 1);
      expect(await failure).toMatchObject({ _tag: "Unknown", detail: "network" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails when the connection is refused, without retrying", async () => {
    const scripted = scriptedFetch(() => json({ Error: "Unauthorized" }, 401));
    await failureOf(
      quoteStream(
        transportWith(scripted.fetch),
        ["AAPL"],
        () => 1,
        () => undefined,
        new AbortController().signal,
      ),
    );
    expect(scripted.calls).toHaveLength(1);
  });

  it("rejects zero or too many symbols before any request", async () => {
    const scripted = scriptedFetch(() => json({}));
    for (const symbols of [[], Array.from({ length: 101 }, (_, i) => `S${i}`)]) {
      const error = await failureOf(
        quoteStream(
          transportWith(scripted.fetch),
          symbols,
          () => 1,
          () => undefined,
          new AbortController().signal,
        ),
      );
      expect(error).toMatchObject({ code: "SYMBOL_COUNT" });
    }
    expect(scripted.calls).toHaveLength(0);
  });
});

import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { Quote } from "../src/broker/adapter.ts";
import { ObjectSplitter, stepOf } from "../src/tradestation/quote-stream.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.result(effect));

describe("ObjectSplitter", () => {
  const a = '{"Symbol":"AAPL","Bid":"1"}';
  const b = '{"Symbol":"MSFT","Message":"a } brace and \\" quote in a string"}';

  it("returns an object that arrives whole", () => {
    expect(new ObjectSplitter().push(a)).toEqual([a]);
  });

  it("returns several objects that arrive in one chunk", () => {
    expect(new ObjectSplitter().push(`${a}\r\n${b}\r\n`)).toEqual([a, b]);
  });

  it("joins an object split across chunks at any byte", () => {
    const text = `${a}${b}`;
    for (let cut = 1; cut < text.length; cut += 1) {
      const splitter = new ObjectSplitter();
      expect([...splitter.push(text.slice(0, cut)), ...splitter.push(text.slice(cut))]).toEqual([
        a,
        b,
      ]);
    }
  });

  it("ignores stray text outside objects", () => {
    expect(new ObjectSplitter().push(` " ,\n${a}`)).toEqual([a]);
  });

  it("refuses an unbounded buffer", () => {
    const splitter = new ObjectSplitter();
    expect(() => splitter.push(`{"x":"${"a".repeat(1_100_000)}`)).toThrow();
  });
});

describe("stepOf", () => {
  const none = new Map<string, Quote>();
  const wire = (body: object, previous = none) => run(stepOf(JSON.stringify(body), previous, 77));

  it("reads a full quote", async () => {
    const result = await wire({
      Symbol: "AAPL",
      Bid: "10.5",
      Ask: "10.6",
      Last: "10.55",
      TradeTime: "2026-10-26T14:00:00Z",
    });
    expect(result).toMatchObject({
      _tag: "Success",
      success: {
        kind: "event",
        event: { kind: "quote", quote: { symbol: "AAPL", bid: 10_500_000, ask: 10_600_000 } },
      },
    });
  });

  it("keeps the previous side when a message leaves it out", async () => {
    const first = await wire({ Symbol: "AAPL", Bid: "10", Ask: "11" });
    if (first._tag !== "Success" || first.success.kind !== "event") throw new Error("no event");
    const { event } = first.success;
    if (event.kind !== "quote") throw new Error("no quote");
    const second = await wire({ Symbol: "AAPL", Ask: "12" }, new Map([["AAPL", event.quote]]));
    expect(second).toMatchObject({
      _tag: "Success",
      success: { event: { quote: { bid: 10_000_000, ask: 12_000_000, receivedAt: 77 } } },
    });
  });

  it("turns a blank side into null, never 0", async () => {
    const result = await wire({ Symbol: "AAPL", Bid: null, Ask: "11" });
    expect(result).toMatchObject({
      _tag: "Success",
      success: { event: { quote: { bid: null, ask: 11_000_000 } } },
    });
  });

  it("reports a heartbeat", async () => {
    expect(await wire({ Heartbeat: 5, Timestamp: "2026-10-26T14:00:00Z" })).toMatchObject({
      _tag: "Success",
      success: { kind: "event", event: { kind: "heartbeat" } },
    });
  });

  it("ends on GoAway and ignores the other stream statuses", async () => {
    expect(await wire({ StreamStatus: "GoAway" })).toMatchObject({
      success: { kind: "end" },
    });
    expect(await wire({ StreamStatus: "EndSnapshot" })).toMatchObject({
      success: { kind: "ignore" },
    });
  });

  it("fails with the error code the stream sent, such as DualLogon", async () => {
    expect(await wire({ Symbol: "AAPL", Error: "DualLogon" })).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "Rejected", code: "DualLogon" },
    });
  });

  it("ignores another symbol's error instead of ending the shared stream (verify)", async () => {
    expect(await wire({ Symbol: "ZZZZ", Error: "SymbolNotFound" })).toMatchObject({
      _tag: "Success",
      success: { kind: "ignore" },
    });
  });

  it("fails on a message that is not JSON", async () => {
    const result = await run(stepOf("{nope", none, 1));
    expect(result).toMatchObject({ _tag: "Failure", failure: { detail: "invalid_response" } });
  });
});

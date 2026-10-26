import { describe, expect, it } from "vitest";
import type { Quote } from "../src/broker/adapter.ts";
import { LiveSockets, type LiveSocketsDeps, type SocketLike } from "../src/live-sockets.ts";
import { QuoteHub } from "../src/quote-hub.ts";

const quote = (symbol: string, ask: number): Quote => ({
  symbol,
  bid: ask - 1,
  ask,
  last: ask,
  tradeTime: 0,
  receivedAt: 500,
  isDelayed: false,
  isHalted: false,
});

class FakeSocket implements SocketLike {
  readonly sent: Array<Record<string, unknown>> = [];
  closed: { code?: number; reason?: string } | null = null;
  #listeners: Record<string, Array<(event: { data: unknown }) => void>> = {};
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
    this.emit("close", undefined);
  }
  addEventListener(type: string, listener: (event: { data: unknown }) => void) {
    (this.#listeners[type] ??= []).push(listener);
  }
  emit(type: string, data: unknown) {
    for (const listener of this.#listeners[type] ?? []) listener({ data });
  }
  watch(body: unknown) {
    this.emit("message", typeof body === "string" ? body : JSON.stringify(body));
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function harness(over: Partial<LiveSocketsDeps> = {}) {
  const emits: Array<(quote: Quote) => void> = [];
  const heartbeats: Array<() => void> = [];
  const prepared: Array<{ symbol: string; ask: number | null; done: () => void }> = [];
  const timers: Array<{ ms: number; callback: () => void }> = [];
  const hub = new QuoteHub({
    maxSymbols: 100,
    backoffBaseMs: 1,
    backoffMaxMs: 1,
    run: (_symbols, onEvent, signal) =>
      new Promise((resolve) => {
        emits.push((q) => onEvent({ kind: "quote", quote: q }));
        heartbeats.push(() => onEvent({ kind: "heartbeat" }));
        signal.addEventListener("abort", () => resolve("ended"));
      }),
    wait: () => Promise.resolve(),
  });
  const sockets = new LiveSockets({
    hub,
    streamAvailable: () => true,
    prepare: (entry, streamed) =>
      new Promise((resolve) => {
        prepared.push({
          symbol: entry.symbol,
          ask: streamed?.ask ?? null,
          done: () =>
            resolve({
              ok: true,
              value: {
                status: "READY",
                intentId: "i",
                symbol: entry.symbol,
                assetType: entry.assetType,
                qty: 3,
                sizeMicros: 300,
                askMicros: streamed?.ask ?? 100,
              },
            } as never),
        });
      }),
    now: () => 900,
    maxSockets: 2,
    maxLifetimeMs: 1000,
    entryMinGapMs: 0,
    // The lifetime timer is recorded to be fired by hand; the gap between sizings really waits.
    setTimer: (callback, ms) =>
      ms === 1000 ? timers.push({ ms, callback }) - 1 : setTimeout(callback, ms),
    clearTimer: () => undefined,
    ...over,
  });
  return { sockets, emits, heartbeats, prepared, timers };
}

const entry = { accountId: "a1", symbol: "AAPL", assetType: "equity" };

describe("LiveSockets", () => {
  it("closes a socket whose first message is not a valid watch", async () => {
    for (const body of [
      "nope",
      { type: "watch", entry: { ...entry, price: 1 } },
      { type: "watch", symbols: ["bad symbol!"] },
      { type: "buy" },
    ]) {
      const { sockets } = harness();
      const socket = new FakeSocket();
      sockets.adopt(socket);
      socket.watch(body);
      expect(socket.closed?.code).toBe(1008);
    }
  });

  it("answers unavailable, leaving the socket open, to a watch over the stream's symbol limit", async () => {
    const { sockets } = harness({});
    const socket = new FakeSocket();
    sockets.adopt(socket);
    // The hub of this harness allows 100 symbols.
    socket.watch({
      type: "watch",
      symbols: Array.from({ length: 101 }, (_, index) => `S${index}`),
    });
    await tick();
    expect(socket.closed).toBeNull();
    expect(socket.sent).toEqual([{ type: "state", state: "unavailable" }]);
  });

  it("refuses a socket past the limit and frees the place when one closes", () => {
    const { sockets } = harness();
    const a = new FakeSocket();
    expect(sockets.adopt(a)).toBe(true);
    expect(sockets.adopt(new FakeSocket())).toBe(true);
    expect(sockets.adopt(new FakeSocket())).toBe(false);
    a.close();
    expect(sockets.adopt(new FakeSocket())).toBe(true);
  });

  it("answers unavailable when the broker has no stream", async () => {
    const { sockets } = harness({ streamAvailable: () => false });
    const socket = new FakeSocket();
    sockets.adopt(socket);
    socket.watch({ type: "watch", symbols: ["AAPL"] });
    await tick();
    expect(socket.sent).toEqual([{ type: "state", state: "unavailable" }]);
  });

  it("sizes the entry from a snapshot first, then from each streamed tick", async () => {
    const { sockets, emits, prepared } = harness();
    const socket = new FakeSocket();
    sockets.adopt(socket);
    socket.watch({ type: "watch", entry });
    await tick();
    expect(prepared.map((p) => p.ask)).toEqual([null]);
    prepared[0]?.done();
    await tick();
    emits[0]?.(quote("AAPL", 101_000_000));
    await tick();
    expect(prepared.map((p) => p.ask)).toEqual([null, 101_000_000]);
    prepared[1]?.done();
    await tick();
    const kinds = socket.sent.map((m) => m.type);
    expect(kinds).toEqual(["entry", "state", "entry"]);
    expect(socket.sent[2]).toMatchObject({ update: { askMicros: 101_000_000 }, receivedAt: 500 });
  });

  it("collapses ticks that arrive while sizing into the latest one", async () => {
    const { sockets, emits, prepared } = harness();
    const socket = new FakeSocket();
    sockets.adopt(socket);
    socket.watch({ type: "watch", entry });
    await tick();
    prepared[0]?.done();
    await tick();
    emits[0]?.(quote("AAPL", 1));
    await tick();
    emits[0]?.(quote("AAPL", 2));
    emits[0]?.(quote("AAPL", 3));
    prepared[1]?.done();
    await tick();
    await tick();
    expect(prepared.map((p) => p.ask)).toEqual([null, 1, 3]);
  });

  it("collapses the ticks of one gap into the latest", async () => {
    const { sockets, emits, prepared } = harness({ entryMinGapMs: 40, now: () => Date.now() });
    const socket = new FakeSocket();
    sockets.adopt(socket);
    socket.watch({ type: "watch", entry });
    await tick();
    prepared[0]?.done();
    await tick();
    emits[0]?.(quote("AAPL", 1));
    await tick();
    emits[0]?.(quote("AAPL", 2));
    await tick();
    expect(prepared).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(prepared.map((p) => p.ask)).toEqual([null, 2]);
  });

  it("holds the gap even when the previous sizing finished long before the next tick", async () => {
    let clock = 1000;
    const { sockets, emits, prepared } = harness({ entryMinGapMs: 40, now: () => clock });
    const socket = new FakeSocket();
    sockets.adopt(socket);
    socket.watch({ type: "watch", entry });
    await tick();
    prepared[0]?.done();
    await tick();
    // The first sizing is over; a tick 10 ms later is inside the gap and must wait for it.
    clock += 10;
    emits[0]?.(quote("AAPL", 1));
    await tick();
    expect(prepared).toHaveLength(1);
    clock += 40;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(prepared.map((p) => p.ask)).toEqual([null, 1]);
  });

  it("drops the answer to a watch that a newer watch replaced", async () => {
    const { sockets, prepared } = harness();
    const socket = new FakeSocket();
    sockets.adopt(socket);
    socket.watch({ type: "watch", entry });
    await tick();
    socket.watch({ type: "watch", entry: { ...entry, symbol: "MSFT" } });
    await tick();
    prepared[0]?.done();
    await tick();
    await tick();
    expect(socket.sent.filter((m) => m.type === "entry")).toEqual([]);
    prepared[1]?.done();
    await tick();
    await tick();
    expect(socket.sent.filter((m) => m.type === "entry")).toHaveLength(1);
  });

  it("pushes plain quotes for chain symbols and forwards the heartbeat as alive", async () => {
    const { sockets, emits, heartbeats } = harness();
    const socket = new FakeSocket();
    sockets.adopt(socket);
    socket.watch({ type: "watch", symbols: ["AAPL 261120C200"] });
    await tick();
    emits[0]?.(quote("AAPL 261120C200", 5));
    heartbeats[0]?.();
    expect(socket.sent).toEqual([
      { type: "state", state: "live" },
      { type: "quote", symbol: "AAPL 261120C200", bid: 4, ask: 5, receivedAt: 500 },
      { type: "alive", receivedAt: 900 },
    ]);
  });

  it("closes its socket after the maximum lifetime", () => {
    const { sockets, timers } = harness();
    const socket = new FakeSocket();
    sockets.adopt(socket);
    expect(timers[0]?.ms).toBe(1000);
    timers[0]?.callback();
    expect(socket.closed?.code).toBe(1000);
    expect(sockets.count).toBe(0);
  });

  it("stops the shared stream when the last socket closes while another watches", async () => {
    const { sockets, emits } = harness();
    const a = new FakeSocket();
    const b = new FakeSocket();
    sockets.adopt(a);
    sockets.adopt(b);
    a.watch({ type: "watch", symbols: ["AAPL"] });
    b.watch({ type: "watch", symbols: ["MSFT"] });
    await tick();
    a.close();
    await tick();
    await tick();
    expect(emits.length).toBeGreaterThanOrEqual(2);
    expect(sockets.count).toBe(1);
  });
});

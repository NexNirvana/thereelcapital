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

const clock = { now: 900 };

function harness(over: Partial<LiveSocketsDeps> = {}) {
  clock.now = 900;
  const emits: Array<(quote: Quote) => void> = [];
  const heartbeats: Array<() => void> = [];
  const prepared: Array<{ symbol: string; ask: number | null; done: () => void }> = [];
  const timers: Array<{ ms: number; callback: () => void }> = [];
  const choices: Array<string | undefined> = [];
  const hub = new QuoteHub({
    maxSymbols: 100,
    maxStreams: 1,
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
        choices.push(entry.sizeChoice);
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
                sizeChoice: entry.sizeChoice ?? "full",
                askMicros: streamed?.ask ?? 100,
              },
            } as never),
        });
      }),
    now: () => clock.now,
    maxSockets: 2,
    maxLifetimeMs: 1000,
    entryRetryMs: 5000,
    // The lifetime timer is recorded to be fired by hand.
    setTimer: (callback, ms) => timers.push({ ms, callback }) - 1,
    clearTimer: () => undefined,
    ...over,
  });
  return { sockets, emits, heartbeats, prepared, timers, choices };
}

const entry = { accountId: "a1", symbol: "AAPL", assetType: "equity" };

describe("LiveSockets", () => {
  it("closes a socket whose first message is not a valid watch", async () => {
    for (const body of [
      "nope",
      { type: "watch", entry: { ...entry, price: 1 } },
      { type: "watch", entry: { ...entry, sizeChoice: "down50" } },
      { type: "watch", entry: { ...entry, sizeMicros: 15 } },
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

  it("sizes the watched entry with the choice the screen named and says which it applied (D51)", async () => {
    const { sockets, prepared, choices } = harness();
    const socket = new FakeSocket();
    sockets.adopt(socket);
    socket.watch({ type: "watch", entry: { ...entry, sizeChoice: "down25" } });
    await tick();
    prepared[0]?.done();
    await tick();
    expect(socket.closed).toBeNull();
    expect(choices).toEqual(["down25"]);
    expect(socket.sent).toContainEqual(
      expect.objectContaining({
        type: "entry",
        update: expect.objectContaining({ status: "ready", sizeChoice: "down25" }),
      }),
    );
  });

  it("answers unavailable, leaving the socket open, to a watch over what the streams can carry", async () => {
    const { sockets } = harness({});
    const socket = new FakeSocket();
    sockets.adopt(socket);
    // The hub of this harness allows one stream of 100 symbols.
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

  it("tells a screen that joins a stream already live", async () => {
    const { sockets, heartbeats } = harness();
    const first = new FakeSocket();
    sockets.adopt(first);
    first.watch({ type: "watch", symbols: ["AAPL"] });
    await tick();
    heartbeats[0]?.();
    const joiner = new FakeSocket();
    sockets.adopt(joiner);
    joiner.watch({ type: "watch", symbols: ["AAPL"] });
    await tick();
    expect(joiner.sent).toEqual([{ type: "state", state: "live" }]);
  });

  it("also sends the quote of the entry's contract when the watch lists it as a symbol", async () => {
    const { sockets, emits } = harness();
    const socket = new FakeSocket();
    sockets.adopt(socket);
    socket.watch({ type: "watch", entry, symbols: [entry.symbol, "MSFT"] });
    await tick();
    emits[0]?.(quote(entry.symbol, 1));
    await tick();
    expect(socket.sent.filter((m) => m.type === "quote")).toEqual([
      expect.objectContaining({ type: "quote", symbol: entry.symbol }),
    ]);
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
    expect(kinds).toEqual(["entry", "state", "quote", "entry"]);
    expect(socket.sent[3]).toMatchObject({ update: { askMicros: 101_000_000 }, receivedAt: 500 });
  });

  it("does not size the entry on every tick while its sizing keeps failing", async () => {
    let calls = 0;
    const { sockets, emits } = harness({
      prepare: () => {
        calls += 1;
        return Promise.resolve(null);
      },
    });
    const socket = new FakeSocket();
    sockets.adopt(socket);
    socket.watch({ type: "watch", entry });
    await tick();
    expect(calls).toBe(1);
    for (const ask of [1, 2, 3]) {
      emits[0]?.(quote("AAPL", ask));
      await tick();
    }
    // The prices still reach the page; only the sizing waits out the retry delay.
    expect(socket.sent.filter((m) => m.type === "quote")).toHaveLength(3);
    expect(calls).toBe(1);
    clock.now += 5000;
    emits[0]?.(quote("AAPL", 4));
    await tick();
    expect(calls).toBe(2);
  });

  it("does not size the entry on every tick while its symbol is rejected", async () => {
    let calls = 0;
    const { sockets, emits } = harness({
      prepare: () => {
        calls += 1;
        return Promise.resolve({
          ok: true,
          value: { status: "BLOCKED", reasons: ["SYMBOL_DETAILS_MISSING"] },
        } as never);
      },
    });
    const socket = new FakeSocket();
    sockets.adopt(socket);
    socket.watch({ type: "watch", entry });
    await tick();
    for (const ask of [1, 2, 3]) {
      emits[0]?.(quote("AAPL", ask));
      await tick();
    }
    expect(calls).toBe(1);
    // The screen still hears why the entry is blocked.
    expect(socket.sent.filter((m) => m.type === "entry")).toHaveLength(1);
    clock.now += 5000;
    emits[0]?.(quote("AAPL", 4));
    await tick();
    expect(calls).toBe(2);
  });

  it("sends the entry symbol's quote at once, without waiting for its sizing", async () => {
    const { sockets, emits, prepared } = harness();
    const socket = new FakeSocket();
    sockets.adopt(socket);
    socket.watch({ type: "watch", entry });
    await tick();
    prepared[0]?.done();
    await tick();
    socket.sent.length = 0;
    emits[0]?.(quote("AAPL", 101_000_000));
    // The sizing of this tick is still running: the price is on the socket already.
    expect(prepared).toHaveLength(2);
    expect(socket.sent.filter((m) => m.type === "entry")).toEqual([]);
    expect(socket.sent).toContainEqual({
      type: "quote",
      symbol: "AAPL",
      bid: 100_999_999,
      ask: 101_000_000,
      receivedAt: 500,
    });
    prepared[1]?.done();
    await tick();
    expect(socket.sent.map((m) => m.type)).toEqual(["state", "quote", "entry"]);
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

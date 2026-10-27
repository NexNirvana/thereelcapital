import { describe, expect, test } from "bun:test";
import { LIVE_STREAM_SILENCE_MS } from "#lib/domain/config.ts";
import type { LiveMessage } from "#lib/domain/live-protocol.ts";
import { parseLiveMessage, startLiveFeed, type FeedSocket } from "./live-feed.ts";

class FakeSocket implements FeedSocket {
  sent: string[] = [];
  closed = false;
  #on: Record<string, Array<(event: { data: unknown }) => void>> = {};
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  addEventListener(type: string, listener: (event: { data: unknown }) => void) {
    (this.#on[type] ??= []).push(listener);
  }
  emit(type: string, data?: unknown) {
    for (const listener of this.#on[type] ?? []) listener({ data });
  }
  push(message: LiveMessage) {
    this.emit("message", JSON.stringify(message));
  }
}

function harness(extra: Partial<Parameters<typeof startLiveFeed>[0]> = {}) {
  let clock = 0;
  const pending = new Map<number, { callback: () => void; ms: number }>();
  let next = 1;
  const timers = {
    set: (callback: () => void, ms: number) => (pending.set(next, { callback, ms }), next++),
    clear: (handle: unknown) => void pending.delete(handle as number),
  };
  const listeners = new Set<() => void>();
  const page = {
    visibilityState: "visible" as "visible" | "hidden",
    addEventListener: (_t: "visibilitychange", l: () => void) => void listeners.add(l),
    removeEventListener: (_t: "visibilitychange", l: () => void) => void listeners.delete(l),
  };
  const sockets: FakeSocket[] = [];
  const messages: LiveMessage[] = [];
  const feed = startLiveFeed({
    watch: { type: "watch", symbols: ["A"] },
    ...extra,
    onMessage: (m) => messages.push(m),
    poll: {
      intervalMs: 2000,
      maxPolls: 3,
      maxBackoffMs: 16000,
      run: async () => true,
    },
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    page,
    timers,
    now: () => clock,
  });
  const pollPending = () => [...pending.values()].filter((t) => t.ms !== 1000);
  const tickCheck = (advance: number) => {
    clock += advance;
    const check = [...pending.entries()].find(([, t]) => t.ms === 1000);
    if (check) {
      pending.delete(check[0]);
      check[1].callback();
    }
  };
  return { sockets, messages, feed, stop: feed, pollPending, tickCheck, page, listeners, pending };
}

describe("startLiveFeed", () => {
  test("polls until the socket delivers, then stops polling", () => {
    const h = harness();
    expect(h.pollPending().length).toBe(1);
    const socket = h.sockets[0]!;
    socket.emit("open");
    expect(JSON.parse(socket.sent[0]!)).toEqual({ type: "watch", symbols: ["A"] });
    socket.push({ type: "alive", receivedAt: 1 });
    expect(h.pollPending().length).toBe(0);
    expect(h.messages).toEqual([{ type: "alive", receivedAt: 1 }]);
  });

  test("falls back to polling after silence, and back off it when data returns", () => {
    const h = harness();
    const socket = h.sockets[0]!;
    socket.emit("open");
    socket.push({ type: "alive", receivedAt: 1 });
    h.tickCheck(LIVE_STREAM_SILENCE_MS + 1);
    expect(h.pollPending().length).toBe(1);
    socket.push({ type: "alive", receivedAt: 2 });
    expect(h.pollPending().length).toBe(0);
  });

  test("keeps a slow poll alongside the stream when asked to", () => {
    const h = harness({ refreshMs: 30000 });
    const socket = h.sockets[0]!;
    socket.emit("open");
    socket.push({ type: "alive", receivedAt: 1 });
    expect(h.pollPending().map((t) => t.ms)).toEqual([30000]);
    h.tickCheck(LIVE_STREAM_SILENCE_MS + 1);
    expect(h.pollPending().map((t) => t.ms)).toEqual([2000]);
  });

  test("sends the watch again on request, once the socket is open", () => {
    let symbols = ["A"];
    const h = harness({ watch: () => ({ type: "watch", symbols }) });
    const socket = h.sockets[0]!;
    h.feed.rewatch();
    expect(socket.sent).toEqual([]);
    socket.emit("open");
    symbols = ["A", "B"];
    h.feed.rewatch();
    expect(socket.sent.map((text) => JSON.parse(text).symbols)).toEqual([["A"], ["A", "B"]]);
  });

  test("polls while the engine says the stream is unavailable", () => {
    const h = harness();
    const socket = h.sockets[0]!;
    socket.emit("open");
    socket.push({ type: "alive", receivedAt: 1 });
    socket.push({ type: "state", state: "unavailable" });
    expect(h.pollPending().length).toBe(1);
  });

  test("keeps polling after a quote while the engine says a stream is down, until it says live", () => {
    const h = harness();
    const socket = h.sockets[0]!;
    socket.emit("open");
    socket.push({ type: "state", state: "unavailable" });
    socket.push({ type: "quote", symbol: "A", bid: 1, ask: 2, receivedAt: 1 });
    expect(h.pollPending().length).toBe(1);
    socket.push({ type: "state", state: "live" });
    expect(h.pollPending().length).toBe(0);
  });

  test("reconnects with a growing delay after the socket closes, and polls meanwhile", () => {
    const h = harness();
    h.sockets[0]!.emit("close");
    expect(h.pollPending().length).toBe(1);
    const delays = () =>
      [...h.pending.values()].map((t) => t.ms).filter((ms) => ms >= 1000 && ms !== 2000);
    expect(delays()).toContain(1000);
  });

  test("closes the socket when the tab is hidden and opens a new one when it is shown", () => {
    const h = harness();
    h.page.visibilityState = "hidden";
    for (const l of h.listeners) l();
    expect(h.sockets[0]!.closed).toBe(true);
    h.page.visibilityState = "visible";
    for (const l of h.listeners) l();
    expect(h.sockets.length).toBe(2);
  });

  test("stop closes the socket and leaves no timer behind", () => {
    const h = harness();
    h.stop();
    expect(h.sockets[0]!.closed).toBe(true);
    expect(h.pending.size).toBe(0);
    expect(h.listeners.size).toBe(0);
  });

  test("ignores messages from a socket that was replaced", () => {
    const h = harness();
    const old = h.sockets[0]!;
    old.emit("close");
    old.push({ type: "alive", receivedAt: 1 });
    expect(h.messages).toEqual([]);
  });
});

describe("parseLiveMessage", () => {
  test("reads every message of the protocol", () => {
    const messages: LiveMessage[] = [
      { type: "state", state: "live" },
      { type: "alive", receivedAt: 3 },
      { type: "quote", symbol: "A", bid: null, ask: 5, receivedAt: 3 },
      {
        type: "entry",
        update: {
          status: "ready",
          symbol: "A",
          assetType: "equity",
          qty: 2,
          sizeMicros: 1,
          askMicros: 2,
        },
        receivedAt: 3,
      },
      { type: "entry", update: { status: "blocked", reasons: ["X"] }, receivedAt: 3 },
    ];
    for (const message of messages)
      expect(parseLiveMessage(JSON.stringify(message))).toEqual(message);
  });

  test("refuses anything else", () => {
    for (const body of [
      1,
      "nope",
      "null",
      "[]",
      '{"type":"x"}',
      '{"type":"state","state":"maybe"}',
      '{"type":"quote","symbol":"A","bid":"1","ask":1,"receivedAt":1}',
      '{"type":"entry","update":{"status":"ready"},"receivedAt":1}',
      '{"type":"entry","update":{"status":"blocked","reasons":[1]},"receivedAt":1}',
    ]) {
      expect(parseLiveMessage(body)).toBeNull();
    }
  });
});

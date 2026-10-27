import { describe, expect, test } from "bun:test";
import type { LiveMessage, WatchMessage } from "#lib/domain/live-protocol.ts";
import { parseLiveMessage } from "./live-feed.ts";
import { createLiveHub, mergeWatches, type FeedSocket, type HubListener } from "./live-hub.ts";

class FakeSocket implements FeedSocket {
  sent: WatchMessage[] = [];
  closed = false;
  #on: Record<string, Array<(event: { data: unknown }) => void>> = {};
  send(data: string) {
    this.sent.push(JSON.parse(data) as WatchMessage);
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

function harness() {
  let clock = 0;
  const pending = new Map<number, { callback: () => void; ms: number }>();
  let next = 1;
  const sockets: FakeSocket[] = [];
  const hub = createLiveHub({
    parse: parseLiveMessage,
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    page: {
      visibilityState: "visible",
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    timers: {
      set: (callback, ms) => (pending.set(next, { callback, ms }), next++),
      clear: (handle) => void pending.delete(handle as number),
    },
    now: () => clock,
  });
  const screen = (watch: WatchMessage) => {
    const received: LiveMessage[] = [];
    let down = 0;
    const listener: HubListener = {
      watch: () => watch,
      onMessage: (message) => received.push(message),
      onDown: () => (down += 1),
    };
    return { listener, received, downs: () => down };
  };
  return { hub, sockets, pending, advance: (ms: number) => (clock += ms), screen };
}

const flush = () => Promise.resolve();

describe("mergeWatches", () => {
  test("keeps the latest entry and every symbol once", () => {
    const entry = { accountId: "A", symbol: "MSFT", assetType: "equity" as const };
    expect(
      mergeWatches([
        { type: "watch", symbols: ["X", "Y"] },
        { type: "watch", entry },
        { type: "watch", symbols: ["Y", "Z"] },
      ]),
    ).toEqual({ type: "watch", entry, symbols: ["X", "Y", "Z"] });
    expect(mergeWatches([])).toEqual({ type: "watch" });
  });
});

describe("createLiveHub", () => {
  test("a retained hub opens one socket and sends nothing to watch", () => {
    const h = harness();
    h.hub.retain();
    expect(h.sockets.length).toBe(1);
    h.sockets[0]!.emit("open");
    expect(h.sockets[0]!.sent).toEqual([{ type: "watch" }]);
  });

  test("screens share the socket: the union is sent and every message reaches every screen", async () => {
    const h = harness();
    const stopLayout = h.hub.retain();
    const socket = h.sockets[0]!;
    socket.emit("open");
    const a = h.screen({ type: "watch", symbols: ["A"] });
    const stopA = h.hub.listen(a.listener);
    await flush();
    expect(socket.sent.at(-1)).toEqual({ type: "watch", symbols: ["A"] });
    const b = h.screen({ type: "watch", symbols: ["B"] });
    const stopB = h.hub.listen(b.listener);
    await flush();
    expect(h.sockets.length).toBe(1);
    expect(socket.sent.at(-1)).toEqual({ type: "watch", symbols: ["A", "B"] });

    socket.push({ type: "alive", receivedAt: 1 });
    expect(a.received).toEqual([{ type: "alive", receivedAt: 1 }]);
    expect(b.received).toEqual([{ type: "alive", receivedAt: 1 }]);

    stopA();
    await flush();
    expect(socket.sent.at(-1)).toEqual({ type: "watch", symbols: ["B"] });
    stopB();
    await flush();
    expect(socket.sent.at(-1)).toEqual({ type: "watch" });
    expect(socket.closed).toBe(false);
    stopLayout();
    expect(socket.closed).toBe(true);
  });

  test("a screen swapped for another within one flush sends the result once, or nothing if unchanged", async () => {
    const h = harness();
    h.hub.retain();
    const socket = h.sockets[0]!;
    socket.emit("open");
    const stopOld = h.hub.listen(h.screen({ type: "watch", symbols: ["A"] }).listener);
    await flush();
    const before = socket.sent.length;
    stopOld();
    h.hub.listen(h.screen({ type: "watch", symbols: ["A"] }).listener);
    await flush();
    expect(socket.sent.length).toBe(before);
    const stopSame = h.hub.listen(h.screen({ type: "watch", symbols: ["B"] }).listener);
    stopSame();
    await flush();
    expect(socket.sent.length).toBe(before);
  });

  test("a screen that comes in later hears the engine's last word", () => {
    const h = harness();
    h.hub.retain();
    const socket = h.sockets[0]!;
    socket.emit("open");
    socket.push({ type: "state", state: "unavailable" });
    expect(h.hub.unavailable).toBe(true);
    socket.push({ type: "alive", receivedAt: 1 });
    expect(h.hub.unavailable).toBe(false);
  });

  test("tells the screens when the socket ends and reconnects with a growing delay", () => {
    const h = harness();
    h.hub.retain();
    const a = h.screen({ type: "watch", symbols: ["A"] });
    h.hub.listen(a.listener);
    h.sockets[0]!.emit("open");
    h.sockets[0]!.emit("close");
    expect(a.downs()).toBe(1);
    expect(h.hub.connected).toBe(false);
    const [first] = [...h.pending.values()];
    expect(first!.ms).toBe(1000);
    first!.callback();
    expect(h.sockets.length).toBe(2);
    h.sockets[1]!.emit("close");
    expect([...h.pending.values()].map((t) => t.ms)).toContain(2000);
  });

  test("a socket that lived long does not grow the delay", () => {
    const h = harness();
    h.hub.retain();
    h.sockets[0]!.emit("open");
    h.advance(15 * 60_000);
    h.sockets[0]!.emit("close");
    expect([...h.pending.values()].map((t) => t.ms)).toEqual([1000]);
  });

  test("the last release closes the socket and leaves no timer behind", () => {
    const h = harness();
    const stop = h.hub.retain();
    h.sockets[0]!.emit("close");
    stop();
    expect(h.pending.size).toBe(0);
    expect(h.sockets.length).toBe(1);
  });
});

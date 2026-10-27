// The browser sockets of one client (D47): each screen opens one, says what it watches, and the
// engine pushes every quote update as it arrives from the single upstream stream (quote-hub.ts).
// The client is the Durable Object that owns these sockets; the web Worker already checked the
// session and addressed this object by it, so nothing a browser sends names a client.
//
// What a browser may say is only a watch: an entry (account, symbol, kind) and symbols. Sizing is
// the engine's: on each tick of the entry's symbol the quote goes out at once, then the quantity is
// computed again from the client's SIZE and the streamed ask, with the same rules as prepareEntry,
// from inputs the engine holds in memory (entry-inputs.ts). The order is still sized from a fresh
// snapshot ask when it is sent.

import { Schema } from "effect";
import {
  WATCH_SYMBOL,
  type EntryUpdate,
  type LiveMessage,
  type WatchEntry,
} from "#lib/domain/live-protocol.ts";
import type { Quote } from "./broker/adapter.ts";
import type { PrepareEntryResult } from "./entries.ts";
import type { HubListener, QuoteHub } from "./quote-hub.ts";
import type { EngineResult } from "./rpc.ts";

/** The part of a WebSocket the sockets use, so tests can drive them without a runtime. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close" | "error", listener: () => void): void;
}

// No length cap here: the 16 KB message limit bounds the list, and a watch over the stream's symbol
// limit is answered `unavailable` by the hub with the socket left open.
const Symbols = Schema.Array(Schema.String.check(Schema.isPattern(WATCH_SYMBOL)));
const WatchMessage = Schema.Struct({
  type: Schema.Literal("watch"),
  entry: Schema.optionalKey(
    Schema.Struct({
      accountId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
      symbol: Schema.String.check(Schema.isPattern(WATCH_SYMBOL)),
      assetType: Schema.Literals(["equity", "option"]),
    }),
  ),
  symbols: Schema.optionalKey(Symbols),
});
const decodeWatch = Schema.decodeUnknownResult(WatchMessage, { onExcessProperty: "error" });
/** A watch is a few hundred bytes; anything bigger is not one. */
const MAX_MESSAGE_CHARS = 16 * 1024;

export interface LiveSocketsDeps {
  readonly hub: QuoteHub;
  /** False when the broker has no quote stream: sockets then say `unavailable` and the page polls. */
  readonly streamAvailable: () => boolean;
  /**
   * The entry as prepareEntry sees it. With `streamed`, that quote replaces the snapshot read.
   * Resolves to null on a failure: the screen keeps what it has and its poll takes over.
   */
  readonly prepare: (
    entry: WatchEntry,
    streamed: Quote | null,
  ) => Promise<EngineResult<PrepareEntryResult> | null>;
  readonly now: () => number;
  readonly maxSockets: number;
  readonly maxLifetimeMs: number;
  readonly setTimer: (callback: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
}

function updateOf(result: PrepareEntryResult): EntryUpdate {
  return result.status === "READY"
    ? {
        status: "ready",
        symbol: result.symbol,
        assetType: result.assetType,
        qty: result.qty,
        sizeMicros: result.sizeMicros,
        askMicros: result.askMicros,
      }
    : { status: "blocked", reasons: result.reasons };
}

class Session implements HubListener {
  readonly #deps: LiveSocketsDeps;
  readonly #socket: SocketLike;
  #entry: WatchEntry | null = null;
  /** Bumped by every watch, so an answer to an older watch is dropped. */
  #generation = 0;
  #computing = false;
  /** The next sizing to do: a streamed quote, or `null` inside for the snapshot read of a new watch. */
  #pending: { readonly quote: Quote | null } | null = null;
  #closed = false;
  #watching = false;

  constructor(deps: LiveSocketsDeps, socket: SocketLike) {
    this.#deps = deps;
    this.#socket = socket;
  }

  get closed(): boolean {
    return this.#closed;
  }

  close(): void {
    this.#closed = true;
  }

  send(message: LiveMessage): void {
    if (this.#closed) return;
    try {
      this.#socket.send(JSON.stringify(message));
    } catch {
      this.#closed = true;
    }
  }

  quote(quote: Quote): void {
    // The price never waits for sizing, whether or not this is the entry's symbol.
    this.send({
      type: "quote",
      symbol: quote.symbol,
      bid: quote.bid,
      ask: quote.ask,
      receivedAt: quote.receivedAt,
    });
    if (this.#entry !== null && quote.symbol === this.#entry.symbol) {
      this.#pending = { quote };
      void this.#drain();
    }
  }

  heartbeat(): void {
    if (this.#watching) this.send({ type: "alive", receivedAt: this.#deps.now() });
  }

  state(state: "live" | "unavailable"): void {
    this.send({ type: "state", state });
  }

  /** Replaces what this socket watches. */
  async watch(id: string, entry: WatchEntry | null, symbols: ReadonlyArray<string>): Promise<void> {
    this.#generation += 1;
    this.#entry = entry;
    this.#pending = null;
    const streamed = [...(entry === null ? [] : [entry.symbol]), ...symbols];
    this.#watching = streamed.length > 0;
    if (!this.#deps.streamAvailable()) {
      this.#deps.hub.release(id);
      this.state("unavailable");
      return;
    }
    if (!this.#deps.hub.watch(id, streamed, this)) {
      // Too many symbols for one stream: this screen keeps polling.
      this.state("unavailable");
      return;
    }
    if (entry !== null) {
      // The first sizing reads a snapshot; later ones use the streamed quotes. All go through the
      // same queue, so an old answer never lands after a newer one.
      this.#pending = { quote: null };
      await this.#drain();
    }
  }

  /** Sizes the entry once at a time; ticks that arrive meanwhile collapse into the latest. */
  async #drain(): Promise<void> {
    if (this.#computing) return;
    this.#computing = true;
    try {
      while (this.#pending !== null && this.#entry !== null && !this.#closed) {
        const { quote } = this.#pending;
        this.#pending = null;
        await this.#compute(this.#entry, quote, this.#generation);
      }
    } finally {
      this.#computing = false;
    }
  }

  async #compute(entry: WatchEntry, streamed: Quote | null, generation: number): Promise<void> {
    const result = await this.#deps.prepare(entry, streamed).catch(() => null);
    if (result === null || !result.ok) return;
    if (generation !== this.#generation || this.#closed) return;
    this.send({
      type: "entry",
      update: updateOf(result.value),
      receivedAt: streamed?.receivedAt ?? this.#deps.now(),
    });
  }
}

export class LiveSockets {
  readonly #deps: LiveSocketsDeps;
  readonly #sessions = new Map<string, Session>();
  #next = 0;

  constructor(deps: LiveSocketsDeps) {
    this.#deps = deps;
  }

  get count(): number {
    return this.#sessions.size;
  }

  /** Adopts an accepted socket. False (nothing adopted) when this client already has too many. */
  adopt(socket: SocketLike): boolean {
    if (this.#sessions.size >= this.#deps.maxSockets) return false;
    this.#next += 1;
    const id = `socket-${this.#next}`;
    const session = new Session(this.#deps, socket);
    this.#sessions.set(id, session);

    const timer = this.#deps.setTimer(() => socket.close(1000, "renew"), this.#deps.maxLifetimeMs);
    const end = () => {
      this.#deps.clearTimer(timer);
      session.close();
      this.#deps.hub.release(id);
      this.#sessions.delete(id);
    };
    socket.addEventListener("close", end);
    socket.addEventListener("error", end);
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string" || event.data.length > MAX_MESSAGE_CHARS) {
        socket.close(1008, "invalid message");
        return;
      }
      const parsed = (() => {
        try {
          return decodeWatch(JSON.parse(event.data) as unknown);
        } catch {
          return null;
        }
      })();
      if (parsed === null || parsed._tag !== "Success") {
        socket.close(1008, "invalid message");
        return;
      }
      const { entry, symbols } = parsed.success;
      void session.watch(id, entry ?? null, symbols ?? []);
    });
    return true;
  }
}

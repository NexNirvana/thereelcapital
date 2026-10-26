// The quote stream: GET /marketdata/stream/quotes/{symbols}, read as chunked JSON where chunk
// boundaries are not message boundaries (docs/tradestation-integration.md#limits-and-streams).
// Nothing here has run against SIM yet: every shape marked (verify) is read from the HTTP streaming
// page of the official docs or assumed from the snapshot quote, and the first SIM session confirms it.

import { Effect, Schema } from "effect";
import { LIVE_STREAM_IDLE_MS, LIVE_STREAM_MAX_SYMBOLS } from "#lib/domain/config.ts";
import type { Quote, QuoteStreamEvent } from "../broker/adapter.ts";
import { Rejected, Unknown, type BrokerError } from "../broker/errors.ts";
import type { Transport } from "./http.ts";
import { WireNumber, blankable, epochOf, microsOf, symbolPath } from "./values.ts";

/** (verify) The stream's own symbol limit is not in the pages we could read; the snapshot's is 100. */
const MAX_STREAM_SYMBOLS = LIVE_STREAM_MAX_SYMBOLS;
/** A message is a few hundred bytes; a buffer past this is a broken stream, not a long message. */
const MAX_BUFFERED_CHARS = 1_000_000;

/**
 * Cuts a text stream into its top-level JSON objects: braces are counted outside strings, so it
 * does not matter whether an object arrives whole, split across chunks, or several to a chunk.
 */
export class ObjectSplitter {
  #buffer = "";
  #depth = 0;
  #inString = false;
  #escaped = false;
  #start = -1;
  /** Characters of the buffer already scanned. */
  #scanned = 0;

  /** Feeds more text; returns the objects completed by it. Throws when the buffer grows unbounded. */
  push(text: string): string[] {
    const objects: string[] = [];
    this.#buffer += text;
    for (let index = this.#scanned; index < this.#buffer.length; index += 1) {
      const char = this.#buffer[index];
      if (this.#inString) {
        if (this.#escaped) this.#escaped = false;
        else if (char === "\\") this.#escaped = true;
        else if (char === '"') this.#inString = false;
        continue;
      }
      // Outside an object only whitespace is expected; a stray quote there must not open a string.
      if (char === '"' && this.#depth > 0) this.#inString = true;
      else if (char === "{") {
        if (this.#depth === 0) this.#start = index;
        this.#depth += 1;
      } else if (char === "}" && this.#depth > 0) {
        this.#depth -= 1;
        if (this.#depth === 0) {
          objects.push(this.#buffer.slice(this.#start, index + 1));
          this.#start = -1;
        }
      }
    }
    // Keep only the unfinished object.
    if (this.#start === -1) {
      this.#buffer = "";
      this.#scanned = 0;
    } else {
      this.#buffer = this.#buffer.slice(this.#start);
      this.#start = 0;
      this.#scanned = this.#buffer.length;
    }
    if (this.#buffer.length > MAX_BUFFERED_CHARS) throw new RangeError("stream buffer too large");
    return objects;
  }
}

const StreamMessage = Schema.Struct({
  Symbol: Schema.optionalKey(Schema.String),
  Bid: blankable(WireNumber),
  Ask: blankable(WireNumber),
  Last: blankable(WireNumber),
  TradeTime: blankable(Schema.String),
  MarketFlags: blankable(
    Schema.Struct({
      IsDelayed: blankable(Schema.Boolean),
      IsHalted: blankable(Schema.Boolean),
    }),
  ),
  // (verify) Heartbeat messages: the integer counter and timestamp are not used, only their arrival.
  Heartbeat: Schema.optionalKey(Schema.Unknown),
  // `{"Symbol":"AAPL","Error":"DualLogon"}`: the client must close the stream (HTTP streaming docs).
  Error: Schema.optionalKey(Schema.String),
  Message: blankable(Schema.String),
  // Only v3 streams (orders, positions) document it, but it is handled if this one sends it.
  StreamStatus: Schema.optionalKey(Schema.String),
});

/** What one message means for the reader. */
export type StreamStep =
  | { readonly kind: "event"; readonly event: QuoteStreamEvent }
  | { readonly kind: "end" }
  | { readonly kind: "ignore" };

/**
 * Turns one message into a step. A side the message leaves out keeps the value `previous` had
 * (verify: whether the stream sends full quotes or only the changed fields); a side it sends
 * blank becomes `null`, never 0.
 */
export function stepOf(
  raw: string,
  previous: ReadonlyMap<string, Quote>,
  receivedAt: number,
): Effect.Effect<StreamStep, BrokerError> {
  return Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: () => new Unknown({ operation: "quoteStream", detail: "invalid_response" }),
    });
    const decoded = Schema.decodeUnknownResult(StreamMessage)(parsed);
    if (decoded._tag !== "Success") {
      return yield* Effect.fail(
        new Unknown({ operation: "quoteStream", detail: "invalid_response" }),
      );
    }
    const message = decoded.success;
    if (message.Error !== undefined) {
      // Only DualLogon is documented to end the stream (HTTP streaming page). (verify) Any other
      // error is taken as one symbol's (an unknown or expired contract) and must not end the shared
      // stream for every other screen.
      if (message.Error !== "DualLogon") return { kind: "ignore" } as const;
      return yield* Effect.fail(
        new Rejected({
          operation: "quoteStream",
          code: message.Error.slice(0, 64),
          reason: (message.Message ?? "").slice(0, 200),
        }),
      );
    }
    if (message.StreamStatus === "GoAway") return { kind: "end" } as const;
    if (message.StreamStatus !== undefined) return { kind: "ignore" } as const;
    if (message.Heartbeat !== undefined) {
      return { kind: "event", event: { kind: "heartbeat" } } as const;
    }
    if (message.Symbol === undefined) return { kind: "ignore" } as const;

    const before = previous.get(message.Symbol);
    const side = (
      field: "Bid" | "Ask" | "Last",
      keep: number | null | undefined,
    ): Effect.Effect<number | null, BrokerError> => {
      const value = message[field];
      if (value === undefined) return Effect.succeed(keep ?? null);
      return value === null ? Effect.succeed(null) : microsOf("quoteStream", field, value);
    };
    const bid = yield* side("Bid", before?.bid);
    const ask = yield* side("Ask", before?.ask);
    const last = yield* side("Last", before?.last);
    const tradeTime =
      message.TradeTime === undefined
        ? (before?.tradeTime ?? null)
        : message.TradeTime === null
          ? null
          : yield* epochOf("quoteStream", "TradeTime", message.TradeTime);
    const quote: Quote = {
      symbol: message.Symbol,
      bid,
      ask,
      last,
      tradeTime,
      receivedAt,
      isDelayed: message.MarketFlags?.IsDelayed ?? before?.isDelayed ?? false,
      isHalted: message.MarketFlags?.IsHalted ?? before?.isHalted ?? false,
    };
    return { kind: "event", event: { kind: "quote", quote } } as const;
  });
}

/** See `BrokerAdapterShape.quoteStream`. */
export const quoteStream = (
  transport: Transport,
  symbols: ReadonlyArray<string>,
  now: () => number,
  onEvent: (event: QuoteStreamEvent) => void,
  signal: AbortSignal,
): Effect.Effect<void, BrokerError> =>
  Effect.gen(function* () {
    if (symbols.length === 0 || symbols.length > MAX_STREAM_SYMBOLS) {
      return yield* Effect.fail(
        new Rejected({
          operation: "quoteStream",
          code: "SYMBOL_COUNT",
          reason: `${symbols.length}`,
        }),
      );
    }
    const body = yield* transport.stream(
      "quoteStream",
      `/marketdata/stream/quotes/${symbolPath(symbols)}`,
      signal,
    );
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const splitter = new ObjectSplitter();
    const latest = new Map<string, Quote>();

    // Cancelling the reader ends a pending read at once, whatever the platform does to the body.
    const cancel = () => void reader.cancel().catch(() => undefined);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();

    // The transport's timeout covers only the connect: a connection that goes silent without closing
    // would hold the read forever, so a read that sees nothing for LIVE_STREAM_IDLE_MS fails.
    const read = Effect.tryPromise({
      try: () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const idle = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("idle")), LIVE_STREAM_IDLE_MS);
        });
        return Promise.race([reader.read(), idle]).finally(() => clearTimeout(timer));
      },
      catch: (): BrokerError => new Unknown({ operation: "quoteStream", detail: "network" }),
    });

    const loop = Effect.gen(function* () {
      for (;;) {
        const chunk = yield* read;
        if (chunk.done) return;
        const objects = yield* Effect.try({
          try: () => splitter.push(decoder.decode(chunk.value, { stream: true })),
          catch: (): BrokerError =>
            new Unknown({ operation: "quoteStream", detail: "invalid_response" }),
        });
        for (const raw of objects) {
          const step = yield* stepOf(raw, latest, now());
          if (step.kind === "end") return;
          if (step.kind === "ignore") continue;
          if (step.event.kind === "quote") latest.set(step.event.quote.symbol, step.event.quote);
          onEvent(step.event);
        }
      }
    });

    // Closing the stream is the abort of the caller: that is an ordinary end, not a failure.
    yield* loop.pipe(
      Effect.catch((error) => (signal.aborted ? Effect.void : Effect.fail(error))),
      Effect.ensuring(
        Effect.promise(async () => {
          signal.removeEventListener("abort", cancel);
          await reader.cancel().catch(() => undefined);
        }),
      ),
    );
  });

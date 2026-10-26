// One upstream quote stream per client, carrying the union of the symbols its open screens watch
// (D47). The hub owns that stream: it starts it when the first screen watches, restarts it when the
// set changes, closes it when none is left, and starts it again with a growing delay when it breaks
// (a stream is a read, so retrying is allowed).
//
// Invariants, because screens come and go while the stream is being restarted:
//  - at most one upstream run exists at any time: a restart waits for the aborted run to finish;
//  - the set a run was started with is compared with the current union every time it ends or a
//    screen changes, so a subscribe or unsubscribe during a restart is never lost;
//  - events of a run that was aborted are dropped.
// Everything here is synchronous bookkeeping on one thread: there is no await between reading and
// writing the subscriber map or the current run (CLAUDE.md, never-break rule 6).

import type { Quote, QuoteStreamEvent } from "./broker/adapter.ts";

export interface HubListener {
  /** A changed quote of a symbol this listener watches. */
  quote(quote: Quote): void;
  /** The broker's heartbeat: the stream is alive and nothing changed. */
  heartbeat(): void;
  /** `live` once the current run delivered something; `unavailable` while it is down. */
  state(state: "live" | "unavailable"): void;
}

/** Runs one upstream stream to its end: `failed` when it broke, `ended` otherwise (also on abort). */
export type StreamRunner = (
  symbols: ReadonlyArray<string>,
  onEvent: (event: QuoteStreamEvent) => void,
  signal: AbortSignal,
) => Promise<"ended" | "failed">;

export interface HubOptions {
  readonly run: StreamRunner;
  /** Resolves after `ms`, or at once when `signal` aborts. Injected so tests control time. */
  readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly maxSymbols: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
}

interface Subscriber {
  readonly symbols: ReadonlySet<string>;
  readonly listener: HubListener;
}

interface Run {
  readonly key: string;
  readonly controller: AbortController;
}

export class QuoteHub {
  readonly #options: HubOptions;
  readonly #subscribers = new Map<string, Subscriber>();
  #supervising = false;
  #run: Run | null = null;
  /** Wakes the supervisor out of a backoff when the watched set changes. */
  #wake: AbortController | null = null;
  #live = false;
  #failures = 0;

  constructor(options: HubOptions) {
    this.#options = options;
  }

  /** Whether any screen is watching (the stream is open or being opened). */
  get watching(): boolean {
    return this.#subscribers.size > 0;
  }

  /**
   * Replaces what `id` watches. Returns false, leaving `id` unsubscribed, when the union would pass
   * the stream's symbol limit: that screen keeps polling.
   */
  watch(id: string, symbols: Iterable<string>, listener: HubListener): boolean {
    const wanted = new Set(symbols);
    if (wanted.size === 0) {
      this.release(id);
      return true;
    }
    const others = new Set<string>();
    for (const [other, subscriber] of this.#subscribers) {
      if (other !== id) for (const symbol of subscriber.symbols) others.add(symbol);
    }
    const union = new Set([...others, ...wanted]);
    if (union.size > this.#options.maxSymbols) {
      this.release(id);
      return false;
    }
    this.#subscribers.set(id, { symbols: wanted, listener });
    this.#changed();
    return true;
  }

  release(id: string): void {
    if (this.#subscribers.delete(id)) this.#changed();
  }

  #union(): string[] {
    const union = new Set<string>();
    for (const { symbols } of this.#subscribers.values()) {
      for (const symbol of symbols) union.add(symbol);
    }
    return [...union].sort();
  }

  #changed(): void {
    if (!this.#supervising) {
      if (this.#subscribers.size > 0) void this.#supervise();
      return;
    }
    // An open run is replaced only when it no longer matches; a backoff is cut short either way.
    if (this.#run !== null && this.#run.key !== this.#union().join("\n"))
      this.#run.controller.abort();
    this.#wake?.abort();
  }

  async #supervise(): Promise<void> {
    this.#supervising = true;
    try {
      for (;;) {
        const symbols = this.#union();
        if (symbols.length === 0) return;
        const controller = new AbortController();
        const run: Run = { key: symbols.join("\n"), controller };
        this.#run = run;
        let delivered = false;
        const outcome = await this.#options
          .run(
            symbols,
            (event) => {
              if (controller.signal.aborted) return;
              if (!delivered) {
                delivered = true;
                this.#failures = 0;
                this.#live = true;
                this.#broadcastState("live");
              }
              this.#dispatch(event);
            },
            controller.signal,
          )
          .catch((): "failed" => "failed");
        this.#run = null;
        if (this.#union().length === 0) return;
        // The set changed while the run was up: start the next one at once, no penalty, and tell
        // nobody the stream is down (the screens keep their prices).
        if (controller.signal.aborted) continue;
        if (this.#live) {
          this.#live = false;
          this.#broadcastState("unavailable");
        }
        if (outcome === "failed" || !delivered) this.#failures += 1;
        const delay = Math.min(
          this.#options.backoffBaseMs * 2 ** Math.max(0, this.#failures - 1),
          this.#options.backoffMaxMs,
        );
        const wake = new AbortController();
        this.#wake = wake;
        await this.#options.wait(delay, wake.signal);
        this.#wake = null;
      }
    } finally {
      this.#supervising = false;
      this.#live = false;
      this.#run = null;
      this.#wake = null;
      // A screen that arrived while the loop was finishing must not be left without a stream.
      if (this.#subscribers.size > 0) void this.#supervise();
    }
  }

  #dispatch(event: QuoteStreamEvent): void {
    for (const { symbols, listener } of this.#subscribers.values()) {
      if (event.kind === "heartbeat") listener.heartbeat();
      else if (symbols.has(event.quote.symbol)) listener.quote(event.quote);
    }
  }

  #broadcastState(state: "live" | "unavailable"): void {
    for (const { listener } of this.#subscribers.values()) listener.state(state);
  }
}

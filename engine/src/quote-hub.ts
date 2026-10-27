// Upstream quote streams per client, carrying the union of the symbols its open screens watch (D47).
// A stream carries at most `maxSymbols` symbols (the documented limit), so a union beyond that is
// spread over as many streams ("lanes") as needed, up to `maxStreams`. The hub owns them: it opens
// a lane when symbols need one, restarts a lane when its own symbols change, closes it when it is
// empty, and starts a broken lane again with a growing delay (a stream is a read, so retrying is
// allowed).
//
// A symbol stays on the lane it is on while any screen watches it; new symbols fill the lanes that
// have room, so a change touches one lane, not all of them. Invariants, because screens come and go
// while lanes are being restarted:
//  - at most one upstream run exists per lane: a restart waits for the aborted run to finish;
//  - the set a run was started with is compared with its lane's symbols every time it ends or a
//    screen changes, so a subscribe or unsubscribe during a restart is never lost;
//  - events of a run that was aborted are dropped.
// Everything here is synchronous bookkeeping on one thread: there is no await between reading and
// writing the subscriber map, the lanes or a lane's current run (CLAUDE.md, never-break rule 6).

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
  /** Identifies the stream (lane) across its runs, for per-stream bookkeeping such as log dedup. */
  streamId: number,
) => Promise<"ended" | "failed">;

export interface HubOptions {
  readonly run: StreamRunner;
  /** Resolves after `ms`, or at once when `signal` aborts. Injected so tests control time. */
  readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Symbols one upstream stream carries. */
  readonly maxSymbols: number;
  /** Upstream streams one client may hold at once. */
  readonly maxStreams: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  /** Called once when a stream is retired, also from its backoff, to drop per-stream bookkeeping. */
  readonly onRetire?: (streamId: number) => void;
}

interface Subscriber {
  readonly symbols: ReadonlySet<string>;
  readonly listener: HubListener;
}

interface Run {
  readonly key: string;
  readonly controller: AbortController;
}

/** One upstream stream and the symbols it carries. */
class Lane {
  readonly symbols = new Set<string>();
  run: Run | null = null;
  /** Wakes the lane out of a backoff when its symbols change. */
  wake: AbortController | null = null;
  readonly id: number;
  retired = false;
  /** Whether the lane's last run delivered and has not ended on its own since. */
  up = false;
  /** Set when a run ended on its own and cleared when the next one delivers. */
  down = false;
  failures = 0;

  constructor(id: number) {
    this.id = id;
  }

  get key(): string {
    return [...this.symbols].sort().join("\n");
  }
}

export class QuoteHub {
  readonly #options: HubOptions;
  readonly #subscribers = new Map<string, Subscriber>();
  #lanes: Lane[] = [];
  #live = false;
  #nextLaneId = 0;

  constructor(options: HubOptions) {
    this.#options = options;
  }

  /** Whether any screen is watching (a stream is open or being opened). */
  get watching(): boolean {
    return this.#subscribers.size > 0;
  }

  /** What a screen that joins now should be told: `null` while the first data is still awaited. */
  get status(): "live" | "unavailable" | null {
    if (this.#lanes.some((lane) => lane.down)) return "unavailable";
    return this.#live ? "live" : null;
  }

  /**
   * Replaces what `id` watches. Returns false, leaving `id` unsubscribed, when the union would pass
   * what all the streams can carry: that screen keeps polling.
   */
  watch(id: string, symbols: Iterable<string>, listener: HubListener): boolean {
    const wanted = new Set(symbols);
    if (wanted.size === 0) {
      this.release(id);
      return true;
    }
    const union = new Set(wanted);
    for (const [other, subscriber] of this.#subscribers) {
      if (other !== id) for (const symbol of subscriber.symbols) union.add(symbol);
    }
    if (union.size > this.#options.maxSymbols * this.#options.maxStreams) {
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

  #union(): Set<string> {
    const union = new Set<string>();
    for (const { symbols } of this.#subscribers.values()) {
      for (const symbol of symbols) union.add(symbol);
    }
    return union;
  }

  /** Re-spreads the union over the lanes, touching only the lanes whose symbols changed. */
  #changed(): void {
    const wanted = this.#union();
    const { maxSymbols } = this.#options;
    const before = this.#lanes.map((lane) => lane.key);
    const lanes = this.#lanes.slice();
    const placed = new Set<string>();
    for (const lane of lanes) {
      for (const symbol of lane.symbols) {
        if (wanted.has(symbol)) placed.add(symbol);
        else lane.symbols.delete(symbol);
      }
    }
    const fresh: Lane[] = [];
    for (const symbol of [...wanted].filter((candidate) => !placed.has(candidate)).sort()) {
      let lane = [...lanes, ...fresh].find((candidate) => candidate.symbols.size < maxSymbols);
      if (lane === undefined) {
        lane = new Lane(this.#nextLaneId++);
        fresh.push(lane);
      }
      lane.symbols.add(symbol);
    }
    // Holes are filled first, so the union (within the cap `watch` checked) never needs more lanes.
    const layout = [...lanes, ...fresh].filter((lane) => lane.symbols.size > 0);
    for (const lane of [...lanes, ...fresh]) {
      if (!layout.includes(lane)) this.#retire(lane);
    }
    this.#lanes = layout;
    for (const lane of layout) {
      if (!lanes.includes(lane)) {
        void this.#supervise(lane);
      } else if (lane.key !== before[lanes.indexOf(lane)]) {
        // An open run is replaced only when it no longer matches; a backoff is cut short either way.
        if (lane.run !== null && lane.run.key !== lane.key) lane.run.controller.abort();
        lane.wake?.abort();
      }
    }
    // A lane that went down may have just been released: the others may be all that is left.
    this.#syncState();
  }

  /** Live when some stream delivers and none is down; announced to the screens on every change. */
  #syncState(): void {
    const live = this.#lanes.some((lane) => lane.up) && !this.#lanes.some((lane) => lane.down);
    if (live === this.#live) return;
    this.#live = live;
    this.#broadcastState(live ? "live" : "unavailable");
  }

  #retire(lane: Lane): void {
    lane.retired = true;
    lane.run?.controller.abort();
    lane.wake?.abort();
    this.#options.onRetire?.(lane.id);
  }

  async #supervise(lane: Lane): Promise<void> {
    while (!lane.retired) {
      const symbols = [...lane.symbols].sort();
      const controller = new AbortController();
      const run: Run = { key: symbols.join("\n"), controller };
      lane.run = run;
      let delivered = false;
      const outcome = await this.#options
        .run(
          symbols,
          (event) => {
            if (controller.signal.aborted) return;
            if (!delivered) {
              delivered = true;
              lane.failures = 0;
              lane.down = false;
              lane.up = true;
              this.#syncState();
            }
            this.#dispatch(event);
          },
          controller.signal,
          lane.id,
        )
        .catch((): "failed" => "failed");
      lane.run = null;
      if (lane.retired) return;
      // The lane's symbols changed while the run was up: start the next one at once, no penalty,
      // and tell nobody the stream is down (the screens keep their prices).
      if (controller.signal.aborted) continue;
      lane.down = true;
      lane.up = false;
      this.#syncState();
      if (outcome === "failed" || !delivered) lane.failures += 1;
      const delay = Math.min(
        this.#options.backoffBaseMs * 2 ** Math.max(0, lane.failures - 1),
        this.#options.backoffMaxMs,
      );
      const wake = new AbortController();
      lane.wake = wake;
      await this.#options.wait(delay, wake.signal);
      lane.wake = null;
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

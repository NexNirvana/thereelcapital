import { describe, expect, it } from "vitest";
import type { Quote, QuoteStreamEvent } from "../src/broker/adapter.ts";
import { QuoteHub, type HubListener } from "../src/quote-hub.ts";

const quote = (symbol: string): Quote => ({
  symbol,
  bid: 1,
  ask: 2,
  last: 1,
  tradeTime: 0,
  receivedAt: 0,
  isDelayed: false,
  isHalted: false,
});

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface FakeRun {
  readonly symbols: ReadonlyArray<string>;
  readonly emit: (event: QuoteStreamEvent) => void;
  readonly signal: AbortSignal;
  readonly finish: (outcome: "ended" | "failed") => void;
}

function harness(maxSymbols = 100) {
  const runs: FakeRun[] = [];
  const waits: number[] = [];
  let open = 0;
  let maxOpen = 0;
  const hub = new QuoteHub({
    maxSymbols,
    backoffBaseMs: 1000,
    backoffMaxMs: 4000,
    run: (symbols, emit, signal) =>
      new Promise((resolve) => {
        open += 1;
        maxOpen = Math.max(maxOpen, open);
        const done = (outcome: "ended" | "failed") => {
          open -= 1;
          resolve(outcome);
        };
        signal.addEventListener("abort", () => done("ended"), { once: true });
        runs.push({ symbols, emit, signal, finish: done });
      }),
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });
  return { hub, runs, waits, maxOpen: () => maxOpen };
}

function listener() {
  const seen: string[] = [];
  const value: HubListener = {
    quote: (q) => seen.push(`q:${q.symbol}`),
    heartbeat: () => seen.push("hb"),
    state: (s) => seen.push(`s:${s}`),
  };
  return { value, seen };
}

describe("QuoteHub", () => {
  it("opens one stream for the union and routes quotes by symbol", async () => {
    const { hub, runs } = harness();
    const a = listener();
    const b = listener();
    hub.watch("a", ["AAPL"], a.value);
    hub.watch("b", ["MSFT"], b.value);
    await tick();
    expect(runs.at(-1)?.symbols).toEqual(["AAPL", "MSFT"]);
    runs.at(-1)?.emit({ kind: "quote", quote: quote("AAPL") });
    runs.at(-1)?.emit({ kind: "heartbeat" });
    expect(a.seen).toEqual(["s:live", "q:AAPL", "hb"]);
    expect(b.seen).toEqual(["s:live", "hb"]);
  });

  it("restarts when the set changes, never with two streams open", async () => {
    const { hub, runs, maxOpen } = harness();
    hub.watch("a", ["AAPL"], listener().value);
    await tick();
    hub.watch("b", ["MSFT"], listener().value);
    hub.watch("c", ["TSLA"], listener().value);
    hub.release("b");
    await tick();
    await tick();
    expect(runs.at(-1)?.symbols).toEqual(["AAPL", "TSLA"]);
    expect(runs.at(-1)?.signal.aborted).toBe(false);
    expect(maxOpen()).toBe(1);
  });

  it("drops events of a run that was replaced, and keeps the screens' state quiet", async () => {
    const { hub, runs } = harness();
    const a = listener();
    hub.watch("a", ["AAPL"], a.value);
    await tick();
    const first = runs[0];
    first?.emit({ kind: "heartbeat" });
    hub.watch("a", ["AAPL", "MSFT"], a.value);
    first?.emit({ kind: "quote", quote: quote("AAPL") });
    await tick();
    expect(a.seen).toEqual(["s:live", "hb"]);
  });

  it("closes the stream when the last screen leaves and reopens for the next", async () => {
    const { hub, runs } = harness();
    hub.watch("a", ["AAPL"], listener().value);
    await tick();
    hub.release("a");
    await tick();
    expect(runs[0]?.signal.aborted).toBe(true);
    expect(hub.watching).toBe(false);
    hub.watch("b", ["MSFT"], listener().value);
    await tick();
    expect(runs).toHaveLength(2);
    expect(runs[1]?.symbols).toEqual(["MSFT"]);
  });

  it("reconnects with a growing delay when the stream breaks, and resets after data", async () => {
    const { hub, runs, waits } = harness();
    const a = listener();
    hub.watch("a", ["AAPL"], a.value);
    await tick();
    runs[0]?.finish("failed");
    await tick();
    runs[1]?.finish("failed");
    await tick();
    runs[2]?.finish("failed");
    await tick();
    runs[3]?.finish("failed");
    await tick();
    expect(waits).toEqual([1000, 2000, 4000, 4000]);
    runs[4]?.emit({ kind: "heartbeat" });
    runs[4]?.finish("failed");
    await tick();
    expect(waits.at(-1)).toBe(1000);
    expect(a.seen).toContain("s:unavailable");
  });

  it("refuses a screen that would pass the symbol limit and leaves it unsubscribed", async () => {
    const { hub } = harness(2);
    expect(hub.watch("a", ["A", "B"], listener().value)).toBe(true);
    expect(hub.watch("b", ["C"], listener().value)).toBe(false);
    expect(hub.watch("b", ["A"], listener().value)).toBe(true);
  });
});

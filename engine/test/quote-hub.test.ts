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
  readonly streamId: number;
  readonly finish: (outcome: "ended" | "failed") => void;
}

function harness(maxSymbols = 100, maxStreams = 5) {
  const runs: FakeRun[] = [];
  const waits: number[] = [];
  let open = 0;
  let maxOpen = 0;
  const retired: number[] = [];
  const hub = new QuoteHub({
    onRetire: (streamId) => retired.push(streamId),
    maxSymbols,
    maxStreams,
    backoffBaseMs: 1000,
    backoffMaxMs: 4000,
    run: (symbols, emit, signal, streamId) =>
      new Promise((resolve) => {
        open += 1;
        maxOpen = Math.max(maxOpen, open);
        const done = (outcome: "ended" | "failed") => {
          open -= 1;
          resolve(outcome);
        };
        signal.addEventListener("abort", () => done("ended"), { once: true });
        runs.push({ symbols, emit, signal, streamId, finish: done });
      }),
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });
  return { hub, runs, waits, retired, maxOpen: () => maxOpen };
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

  it("replaces a stream that has not delivered yet at once, never with two open", async () => {
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

  it("keeps the old stream delivering until the one for the new set delivers", async () => {
    const { hub, runs, maxOpen } = harness();
    const a = listener();
    hub.watch("a", ["AAPL"], a.value);
    await tick();
    const [old] = runs;
    old?.emit({ kind: "quote", quote: quote("AAPL") });
    hub.watch("b", ["MSFT"], listener().value);
    await tick();
    const next = runs[1];
    expect(next?.symbols).toEqual(["AAPL", "MSFT"]);
    // The new stream is still connecting: AAPL keeps ticking on the old one.
    expect(old?.signal.aborted).toBe(false);
    old?.emit({ kind: "quote", quote: quote("AAPL") });
    expect(a.seen).toEqual(["s:live", "q:AAPL", "q:AAPL"]);
    // Once the new stream delivers, it takes over and the old one is closed.
    next?.emit({ kind: "quote", quote: quote("AAPL") });
    expect(old?.signal.aborted).toBe(true);
    old?.emit({ kind: "quote", quote: quote("AAPL") });
    expect(a.seen).toEqual(["s:live", "q:AAPL", "q:AAPL", "q:AAPL"]);
    expect(maxOpen()).toBe(2);
  });

  it("keeps the last requested set when watches change while a stream is connecting", async () => {
    const { hub, runs } = harness();
    hub.watch("a", ["AAPL"], listener().value);
    await tick();
    runs[0]?.emit({ kind: "heartbeat" });
    hub.watch("b", ["MSFT"], listener().value);
    await tick();
    hub.watch("c", ["TSLA"], listener().value);
    await tick();
    hub.release("b");
    await tick();
    await tick();
    const open = runs.filter((run) => !run.signal.aborted);
    expect(open.map((run) => run.symbols)).toEqual([["AAPL"], ["AAPL", "TSLA"]]);
    runs.at(-1)?.emit({ kind: "heartbeat" });
    expect(runs.filter((run) => !run.signal.aborted)).toHaveLength(1);
    expect(runs.at(-1)?.symbols).toEqual(["AAPL", "TSLA"]);
  });

  it("falls back to a backoff restart when the new stream fails before delivering", async () => {
    const { hub, runs, waits } = harness();
    const a = listener();
    hub.watch("a", ["AAPL"], a.value);
    await tick();
    runs[0]?.emit({ kind: "heartbeat" });
    hub.watch("b", ["MSFT"], listener().value);
    await tick();
    runs[1]?.finish("failed");
    await tick();
    await tick();
    expect(runs[0]?.signal.aborted).toBe(true);
    expect(waits).toEqual([1000]);
    expect(runs.at(-1)?.symbols).toEqual(["AAPL", "MSFT"]);
    expect(a.seen).toContain("s:unavailable");
  });

  it("closes both the stream and its successor when the last screen leaves", async () => {
    const { hub, runs } = harness();
    hub.watch("a", ["AAPL"], listener().value);
    await tick();
    runs[0]?.emit({ kind: "heartbeat" });
    hub.watch("b", ["MSFT"], listener().value);
    await tick();
    hub.release("a");
    hub.release("b");
    await tick();
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.signal.aborted)).toBe(true);
    expect(hub.watching).toBe(false);
  });

  it("applies a change made while the replaced stream is still closing", async () => {
    const { hub, runs } = harness();
    hub.watch("a", ["AAPL"], listener().value);
    await tick();
    runs[0]?.emit({ kind: "heartbeat" });
    hub.watch("b", ["MSFT"], listener().value);
    await tick();
    // The successor delivers and the old stream is told to close, but has not settled yet.
    runs[1]?.emit({ kind: "heartbeat" });
    hub.watch("c", ["TSLA"], listener().value);
    expect(runs).toHaveLength(2);
    await tick();
    await tick();
    const open = runs.filter((run) => !run.signal.aborted);
    expect(open.map((run) => run.symbols)).toEqual([
      ["AAPL", "MSFT"],
      ["AAPL", "MSFT", "TSLA"],
    ]);
    runs.at(-1)?.emit({ kind: "heartbeat" });
    expect(runs.filter((run) => !run.signal.aborted).map((run) => run.symbols)).toEqual([
      ["AAPL", "MSFT", "TSLA"],
    ]);
  });

  it("drops events of a run that was replaced, and keeps the screens' state quiet", async () => {
    const { hub, runs } = harness();
    const a = listener();
    hub.watch("a", ["AAPL"], a.value);
    await tick();
    const first = runs[0];
    first?.emit({ kind: "heartbeat" });
    hub.watch("a", ["AAPL", "MSFT"], a.value);
    await tick();
    runs[1]?.emit({ kind: "heartbeat" });
    first?.emit({ kind: "quote", quote: quote("AAPL") });
    await tick();
    expect(a.seen).toEqual(["s:live", "hb", "hb"]);
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

  it("reports a stream retired while it backs off, so its failure bookkeeping is dropped", async () => {
    const { hub, runs, retired } = harness();
    hub.watch("a", ["AAPL"], listener().value);
    await tick();
    const streamId = runs[0]?.streamId;
    // Retired after the failure, before the backoff ends: no further run would clear it.
    runs[0]?.finish("failed");
    hub.release("a");
    await tick();
    expect(retired).toEqual([streamId]);
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

  it("refuses a screen that would pass what the streams carry and leaves it unsubscribed", async () => {
    const { hub } = harness(2, 1);
    expect(hub.watch("a", ["A", "B"], listener().value)).toBe(true);
    expect(hub.watch("b", ["C"], listener().value)).toBe(false);
    expect(hub.watch("b", ["A"], listener().value)).toBe(true);
  });

  describe("more symbols than one stream carries", () => {
    const symbols = (count: number) => Array.from({ length: count }, (_, i) => `S${i}`);

    it.each([100, 101, 180])("streams every one of %i symbols", async (count) => {
      const { hub, runs } = harness();
      const a = listener();
      const wanted = symbols(count);
      expect(hub.watch("a", wanted, a.value)).toBe(true);
      await tick();
      expect(runs).toHaveLength(Math.ceil(count / 100));
      for (const run of runs) expect(run.symbols.length).toBeLessThanOrEqual(100);
      expect(runs.flatMap((run) => [...run.symbols]).sort()).toEqual([...wanted].sort());
      for (const symbol of wanted) {
        const run = runs.find((candidate) => candidate.symbols.includes(symbol));
        run?.emit({ kind: "quote", quote: quote(symbol) });
      }
      expect(a.seen.filter((entry) => entry.startsWith("q:"))).toHaveLength(count);
    });

    it("refuses a watch that would pass the total cap", async () => {
      const { hub } = harness(100, 2);
      expect(hub.watch("a", symbols(200), listener().value)).toBe(true);
      expect(hub.watch("b", symbols(201), listener().value)).toBe(false);
    });

    it("forwards the heartbeat of every stream and announces live once", async () => {
      const { hub, runs } = harness();
      const a = listener();
      hub.watch("a", symbols(150), a.value);
      await tick();
      runs[0]?.emit({ kind: "heartbeat" });
      runs[1]?.emit({ kind: "heartbeat" });
      expect(a.seen.filter((entry) => entry === "hb")).toHaveLength(2);
      expect(a.seen.filter((entry) => entry === "s:live")).toHaveLength(1);
    });

    it("restarts only the stream whose symbols changed", async () => {
      const { hub, runs } = harness();
      hub.watch("a", symbols(150), listener().value);
      await tick();
      const [first, second] = runs;
      const room = first && first.symbols.length < 100 ? first : second;
      const full = room === first ? second : first;
      hub.watch("b", ["EXTRA"], listener().value);
      await tick();
      expect(full?.signal.aborted).toBe(false);
      expect(room?.signal.aborted).toBe(true);
      expect(runs).toHaveLength(3);
      expect(runs.at(-1)?.symbols).toContain("EXTRA");
    });

    it("fills the holes of released symbols before opening another stream", async () => {
      const { hub, runs } = harness(2, 2);
      hub.watch("a", ["A", "B"], listener().value);
      hub.watch("b", ["C"], listener().value);
      await tick();
      hub.watch("a", ["A"], listener().value);
      expect(hub.watch("c", ["D", "E"], listener().value)).toBe(true);
      await tick();
      expect(runs.filter((run) => !run.signal.aborted)).toHaveLength(2);
      expect(hub.watch("d", ["F"], listener().value)).toBe(false);
    });

    it("goes live again when the lane that was down is released", async () => {
      const { hub, runs } = harness(2, 2);
      const a = listener();
      hub.watch("a", ["A", "B"], a.value);
      hub.watch("b", ["C"], listener().value);
      await tick();
      runs[0]?.emit({ kind: "heartbeat" });
      runs[1]?.finish("failed");
      await tick();
      expect(hub.status).toBe("unavailable");
      hub.release("b");
      expect(hub.status).toBe("live");
      expect(a.seen.filter((entry) => entry.startsWith("s:"))).toEqual([
        "s:live",
        "s:unavailable",
        "s:live",
      ]);
    });

    it("says unavailable while any stream is down, live again once it delivers", async () => {
      const { hub, runs } = harness();
      const a = listener();
      hub.watch("a", symbols(150), a.value);
      await tick();
      runs[0]?.emit({ kind: "heartbeat" });
      runs[1]?.emit({ kind: "heartbeat" });
      runs[1]?.finish("failed");
      await tick();
      expect(a.seen).toContain("s:unavailable");
      runs[2]?.emit({ kind: "heartbeat" });
      expect(a.seen.at(-2)).toBe("s:live");
    });
  });
});

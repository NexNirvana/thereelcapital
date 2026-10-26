// Keeps a screen's prices live: runs `run` on a timer while the tab is visible, slows down after a
// failure, stops after `maxPolls` and starts again when the client comes back to the tab. The
// prices it fetches are display only (D46); nothing here decides or sends an order.

export interface LivePollPage {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface LivePollTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface LivePollOptions {
  /**
   * Reads once and says whether it worked. A throw counts as a failure. The signal aborts when the
   * poll is stopped: a read still in flight must not write its answer after that.
   */
  readonly run: (signal: AbortSignal) => Promise<boolean>;
  readonly intervalMs: number;
  readonly maxPolls: number;
  readonly maxBackoffMs: number;
  readonly page?: LivePollPage;
  readonly timers?: LivePollTimers;
}

const BROWSER_TIMERS: LivePollTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Delay before the next poll: the base pace, doubled for every failure in a row, up to the cap. */
export function nextDelayMs(intervalMs: number, failures: number, maxBackoffMs: number): number {
  return Math.min(intervalMs * 2 ** failures, Math.max(intervalMs, maxBackoffMs));
}

/** Starts polling; the returned function stops it for good (call it when the screen goes away). */
export function startLivePoll(options: LivePollOptions): () => void {
  const page = options.page ?? document;
  const timers = options.timers ?? BROWSER_TIMERS;
  let polls = 0;
  let failures = 0;
  let handle: unknown = null;
  let inFlight = false;
  let stopped = false;
  const controller = new AbortController();

  const clearTimer = () => {
    if (handle !== null) timers.clear(handle);
    handle = null;
  };

  const schedule = () => {
    clearTimer();
    if (stopped || inFlight || polls >= options.maxPolls || page.visibilityState !== "visible") {
      return;
    }
    handle = timers.set(
      () => void poll(),
      nextDelayMs(options.intervalMs, failures, options.maxBackoffMs),
    );
  };

  async function poll() {
    handle = null;
    if (stopped || inFlight || page.visibilityState !== "visible") return;
    inFlight = true;
    polls += 1;
    const worked = await options.run(controller.signal).catch(() => false);
    inFlight = false;
    failures = worked ? 0 : failures + 1;
    schedule();
  }

  // A hidden tab stops polling; coming back reads at once, and a tab that had used up its polls
  // starts the count again.
  const onVisibility = () => {
    if (stopped) return;
    if (page.visibilityState !== "visible") {
      clearTimer();
      return;
    }
    if (polls >= options.maxPolls) polls = 0;
    clearTimer();
    void poll();
  };

  page.addEventListener("visibilitychange", onVisibility);
  schedule();
  return () => {
    stopped = true;
    controller.abort();
    clearTimer();
    page.removeEventListener("visibilitychange", onVisibility);
  };
}

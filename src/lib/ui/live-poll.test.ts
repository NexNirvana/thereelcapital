import { expect, test } from "bun:test";
import { nextDelayMs, startLivePoll, type LivePollPage, type LivePollTimers } from "./live-poll.ts";

function harness() {
  const pending = new Map<number, { callback: () => void; ms: number }>();
  let next = 1;
  const timers: LivePollTimers = {
    set: (callback, ms) => {
      pending.set(next, { callback, ms });
      return next++;
    },
    clear: (handle) => void pending.delete(handle as number),
  };
  const listeners = new Set<() => void>();
  const page = {
    visibilityState: "visible",
    addEventListener: (_type: "visibilitychange", listener: () => void) =>
      void listeners.add(listener),
    removeEventListener: (_type: "visibilitychange", listener: () => void) =>
      void listeners.delete(listener),
  } satisfies LivePollPage;
  const fire = async () => {
    const [entry] = [...pending.values()];
    if (!entry) throw new Error("no timer pending");
    pending.clear();
    entry.callback();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };
  const setVisible = async (visible: boolean) => {
    page.visibilityState = visible ? "visible" : "hidden";
    for (const listener of listeners) listener();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { pending, timers, listeners, page, fire, setVisible };
}

const base = { intervalMs: 2000, maxPolls: 3, maxBackoffMs: 16000 };

test("the delay doubles for every failure and stops at the cap", () => {
  expect([0, 1, 2, 3, 4, 5].map((n) => nextDelayMs(2000, n, 16000))).toEqual([
    2000, 4000, 8000, 16000, 16000, 16000,
  ]);
});

test("polls on the base pace and schedules the next one after each answer", async () => {
  const h = harness();
  let calls = 0;
  startLivePoll({ ...base, run: async () => (calls++, true), page: h.page, timers: h.timers });
  expect([...h.pending.values()].map((t) => t.ms)).toEqual([2000]);
  await h.fire();
  expect(calls).toBe(1);
  expect([...h.pending.values()].map((t) => t.ms)).toEqual([2000]);
});

test("slows down after failures, including a throw, and recovers on success", async () => {
  const h = harness();
  const outcomes = [false, "throw", true];
  startLivePoll({
    ...base,
    maxPolls: 10,
    run: async () => {
      const outcome = outcomes.shift();
      if (outcome === "throw") throw new Error("down");
      return outcome === true;
    },
    page: h.page,
    timers: h.timers,
  });
  await h.fire();
  expect([...h.pending.values()].map((t) => t.ms)).toEqual([4000]);
  await h.fire();
  expect([...h.pending.values()].map((t) => t.ms)).toEqual([8000]);
  await h.fire();
  expect([...h.pending.values()].map((t) => t.ms)).toEqual([2000]);
});

test("stops after the maximum number of polls and resumes when the tab comes back", async () => {
  const h = harness();
  let calls = 0;
  startLivePoll({ ...base, run: async () => (calls++, true), page: h.page, timers: h.timers });
  for (let i = 0; i < 3; i++) await h.fire();
  expect(calls).toBe(3);
  expect(h.pending.size).toBe(0);
  await h.setVisible(false);
  await h.setVisible(true);
  expect(calls).toBe(4);
  expect(h.pending.size).toBe(1);
});

test("does not poll while the tab is hidden and reads at once when it is visible again", async () => {
  const h = harness();
  let calls = 0;
  startLivePoll({ ...base, run: async () => (calls++, true), page: h.page, timers: h.timers });
  await h.setVisible(false);
  expect(h.pending.size).toBe(0);
  expect(calls).toBe(0);
  await h.setVisible(true);
  expect(calls).toBe(1);
  expect(h.pending.size).toBe(1);
});

test("never overlaps two reads and stop removes the timer and the listener", async () => {
  const h = harness();
  let release: (value: boolean) => void = () => {};
  let signal: AbortSignal | undefined;
  let calls = 0;
  const stop = startLivePoll({
    ...base,
    run: (given) => (
      calls++,
      (signal = given),
      new Promise<boolean>((resolve) => (release = resolve))
    ),
    page: h.page,
    timers: h.timers,
  });
  await h.fire();
  await h.setVisible(false);
  await h.setVisible(true);
  expect(calls).toBe(1);
  release(true);
  await Promise.resolve();
  await Promise.resolve();
  stop();
  expect(signal?.aborted).toBe(true);
  expect(h.pending.size).toBe(0);
  expect(h.listeners.size).toBe(0);
});

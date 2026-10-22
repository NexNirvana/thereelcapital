import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { AlarmScheduler } from "../src/scheduler.ts";

const FAR = Date.now() + 60 * 60 * 1000;

/** Each test gets its own Durable Object so alarms and KV never leak between them. */
let counter = 0;
async function withScheduler<T>(
  body: (scheduler: AlarmScheduler, state: DurableObjectState) => Promise<T>,
): Promise<T> {
  const stub = env.COORDINATOR.getByName(`scheduler-${++counter}`);
  await stub.ping();
  return runInDurableObject(stub, (_instance, state) =>
    body(new AlarmScheduler(state.storage), state),
  );
}

describe("AlarmScheduler", () => {
  it("arms the single alarm for the earliest of the two jobs", async () => {
    const alarm = await withScheduler(async (scheduler, state) => {
      await scheduler.schedule("refresh", FAR + 10_000);
      await scheduler.schedule("sync", FAR);
      return state.storage.getAlarm();
    });
    expect(alarm).toBe(FAR);
  });

  it("does not overwrite one job's time when the other is scheduled", async () => {
    const result = await withScheduler(async (scheduler, state) => {
      await scheduler.schedule("sync", FAR);
      await scheduler.schedule("refresh", FAR + 5_000);
      await scheduler.schedule("sync", FAR + 20_000);
      return { alarm: await state.storage.getAlarm(), refresh: scheduler.dueAt("refresh") };
    });
    // The refresh is now the earliest, and it still has its own time.
    expect(result).toEqual({ alarm: FAR + 5_000, refresh: FAR + 5_000 });
  });

  it("re-arms for the other job once one is unscheduled, and clears the alarm when none is", async () => {
    const result = await withScheduler(async (scheduler, state) => {
      await scheduler.schedule("refresh", FAR);
      await scheduler.schedule("sync", FAR + 1_000);
      await scheduler.schedule("refresh", null);
      const afterRefresh = await state.storage.getAlarm();
      await scheduler.schedule("sync", null);
      return { afterRefresh, afterBoth: await state.storage.getAlarm() };
    });
    expect(result).toEqual({ afterRefresh: FAR + 1_000, afterBoth: null });
  });

  it("lists every due job, earliest first, and none that is still in the future", async () => {
    const due = await withScheduler(async (scheduler) => {
      await scheduler.schedule("sync", 2_000);
      await scheduler.schedule("refresh", 1_000);
      const both = scheduler.due(2_000);
      await scheduler.schedule("refresh", FAR);
      return { both, onlySync: scheduler.due(2_000) };
    });
    expect(due).toEqual({ both: ["refresh", "sync"], onlySync: ["sync"] });
  });

  it("scheduleNoLater keeps an earlier time and pulls a later one forward", async () => {
    const times = await withScheduler(async (scheduler) => {
      await scheduler.schedule("sync", FAR);
      await scheduler.scheduleNoLater("sync", FAR + 5_000);
      const kept = scheduler.dueAt("sync");
      await scheduler.scheduleNoLater("sync", FAR - 5_000);
      return { kept, pulled: scheduler.dueAt("sync") };
    });
    expect(times).toEqual({ kept: FAR, pulled: FAR - 5_000 });
  });

  it("arms an overdue job for now, not for the past", async () => {
    const before = Date.now();
    // An alarm armed for now would fire at once and clear itself before it could be read back, so
    // record the time the scheduler asks for and park the real alarm an hour away.
    const armed: number[] = [];
    await withScheduler(async (_scheduler, state) => {
      const recording = new Proxy(state.storage, {
        get(target, property) {
          if (property === "setAlarm") {
            return (at: number | Date) => {
              armed.push(Number(at));
              return target.setAlarm(FAR);
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      await new AlarmScheduler(recording).schedule("sync", 1);
    });
    expect(armed).toHaveLength(1);
    expect(armed[0]).toBeGreaterThanOrEqual(before);
  });
});

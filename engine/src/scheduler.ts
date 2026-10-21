// A Durable Object has ONE alarm. Two jobs need it (token refresh and the sync loop), so each
// keeps its own due time in storage and a single alarm is armed for the earliest of them
// (docs/architecture.md#runtime-behavior). Due times live in KV storage, so they survive eviction.

export type AlarmTask = "refresh" | "sync";

const TASKS: readonly AlarmTask[] = ["refresh", "sync"];
const dueKey = (task: AlarmTask) => `alarm_due:${task}`;

export class AlarmScheduler {
  constructor(private readonly storage: DurableObjectStorage) {}

  /** When the task is next due; null when it is not scheduled. */
  dueAt(task: AlarmTask): number | null {
    return this.storage.kv.get<number>(dueKey(task)) ?? null;
  }

  /** Replaces the task's due time (null unschedules it) and re-arms the alarm. */
  async schedule(task: AlarmTask, at: number | null): Promise<void> {
    if (at === null) this.storage.kv.delete(dueKey(task));
    else this.storage.kv.put(dueKey(task), at);
    await this.arm();
  }

  /** Like `schedule`, but never postpones a time that is already earlier. */
  async scheduleNoLater(task: AlarmTask, at: number): Promise<void> {
    const current = this.dueAt(task);
    await this.schedule(task, current === null ? at : Math.min(current, at));
  }

  /** Tasks whose time has come, earliest first. They stay scheduled until their owner reschedules. */
  due(now: number): AlarmTask[] {
    return TASKS.flatMap((task) => {
      const at = this.dueAt(task);
      return at !== null && at <= now ? [{ task, at }] : [];
    })
      .sort((a, b) => a.at - b.at)
      .map(({ task }) => task);
  }

  /** One alarm for the earliest due time of any task, or none when nothing is scheduled. */
  async arm(): Promise<void> {
    const times = TASKS.map((task) => this.dueAt(task)).filter((at) => at !== null);
    if (times.length === 0) await this.storage.deleteAlarm();
    else await this.storage.setAlarm(Math.max(Math.min(...times), Date.now()));
  }
}

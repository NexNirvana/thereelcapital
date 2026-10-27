// Collects what arrives within one animation frame and hands it over together, in arrival order, so
// a burst of live ticks costs one render and not one per tick.

export interface FrameScheduler {
  /** Runs `callback` before the next paint; the returned function cancels it. */
  request(callback: () => void): () => void;
}

export const BROWSER_FRAMES: FrameScheduler = {
  request: (callback) => {
    const handle = requestAnimationFrame(callback);
    return () => cancelAnimationFrame(handle);
  },
};

export interface FrameBatch<T> {
  add(item: T): void;
  /** Drops what is waiting, for data that a newer full read has already overtaken. */
  clear(): void;
  /** Cancels the frame; nothing waiting is delivered. */
  stop(): void;
}

export function createFrameBatch<T>(
  deliver: (items: ReadonlyArray<T>) => void,
  frames: FrameScheduler = BROWSER_FRAMES,
): FrameBatch<T> {
  let waiting: T[] = [];
  let cancel: (() => void) | null = null;
  return {
    add(item) {
      waiting.push(item);
      if (cancel !== null) return;
      cancel = frames.request(() => {
        cancel = null;
        const items = waiting;
        waiting = [];
        if (items.length > 0) deliver(items);
      });
    },
    clear() {
      waiting = [];
    },
    stop() {
      cancel?.();
      cancel = null;
      waiting = [];
    },
  };
}

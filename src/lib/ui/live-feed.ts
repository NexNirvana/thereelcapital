// Keeps a screen's prices live over the socket to the engine (D47) and falls back, by itself, to the
// snapshot polling of D46 whenever the socket is not delivering. The prices are display only: the
// socket carries what the screen watches out and quote updates in, never a price or a quantity the
// engine would trust.
//
// The screen is "on the stream" while the socket is open and something arrived within
// `LIVE_STREAM_SILENCE_MS` (the broker's heartbeat, forwarded, counts). Otherwise the poll runs.

import {
  LIVE_STREAM_BACKOFF_BASE_MS,
  LIVE_STREAM_BACKOFF_MAX_MS,
  LIVE_STREAM_SILENCE_MS,
} from "#lib/domain/config.ts";
import type { LiveMessage, WatchMessage } from "#lib/domain/live-protocol.ts";
import {
  startLivePoll,
  type LivePollOptions,
  type LivePollPage,
  type LivePollTimers,
} from "./live-poll.ts";

/** The part of a browser WebSocket the feed uses. */
export interface FeedSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "close" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

export interface LiveFeedOptions {
  /** What the screen watches; sent again every time the socket (re)opens. A function is read each time, so the screen can change it (see `rewatch`). */
  readonly watch: WatchMessage | (() => WatchMessage);
  /** Every message the engine pushes. The screen turns them into what it shows. */
  readonly onMessage: (message: LiveMessage) => void;
  /** The snapshot polling that takes over when the socket is not delivering (unchanged from D46). */
  readonly poll: LivePollOptions;
  /**
   * When set, the poll also runs while the stream delivers, at this slower pace (for a screen whose
   * stream cannot reach everything the poll reads).
   */
  readonly refreshMs?: number;
  readonly createSocket?: (path: string) => FeedSocket;
  readonly page?: LivePollPage;
  readonly timers?: LivePollTimers;
  readonly now?: () => number;
}

export const LIVE_SOCKET_PATH = "/operar/en-vivo";

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isPrice = (value: unknown): value is number | null => value === null || isNumber(value);

/** Narrows a socket message; anything else is `null` and ignored rather than guessed at. */
export function parseLiveMessage(text: unknown): LiveMessage | null {
  if (typeof text !== "string") return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
  const message = body as Record<string, unknown>;
  switch (message.type) {
    case "state":
      return message.state === "live" || message.state === "unavailable"
        ? { type: "state", state: message.state }
        : null;
    case "alive":
      return isNumber(message.receivedAt)
        ? { type: "alive", receivedAt: message.receivedAt }
        : null;
    case "quote":
      return typeof message.symbol === "string" &&
        isPrice(message.bid) &&
        isPrice(message.ask) &&
        isNumber(message.receivedAt)
        ? {
            type: "quote",
            symbol: message.symbol,
            bid: message.bid,
            ask: message.ask,
            receivedAt: message.receivedAt,
          }
        : null;
    case "entry": {
      const update = message.update as Record<string, unknown> | null | undefined;
      if (typeof update !== "object" || update === null || !isNumber(message.receivedAt)) {
        return null;
      }
      if (update.status === "blocked") {
        return Array.isArray(update.reasons) &&
          update.reasons.every((reason) => typeof reason === "string")
          ? {
              type: "entry",
              update: { status: "blocked", reasons: update.reasons as string[] },
              receivedAt: message.receivedAt,
            }
          : null;
      }
      const { symbol, assetType, qty, sizeMicros, askMicros } = update;
      if (update.status !== "ready" || typeof symbol !== "string") return null;
      if (assetType !== "equity" && assetType !== "option") return null;
      if (!isNumber(qty) || !isNumber(sizeMicros) || !isNumber(askMicros)) return null;
      return {
        type: "entry",
        update: { status: "ready", symbol, assetType, qty, sizeMicros, askMicros },
        receivedAt: message.receivedAt,
      };
    }
    default:
      return null;
  }
}

function browserSocket(path: string): FeedSocket {
  const url = new URL(path, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(url);
}

const BROWSER_TIMERS: LivePollTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** `stop` ends the feed for good (when the screen goes away); `rewatch` sends the watch again. */
export interface LiveFeedHandle {
  (): void;
  rewatch: () => void;
}

/** Starts the feed; the returned function stops it, and its `rewatch` re-sends what is watched. */
export function startLiveFeed(options: LiveFeedOptions): LiveFeedHandle {
  const page = options.page ?? document;
  const timers = options.timers ?? BROWSER_TIMERS;
  const now = options.now ?? Date.now;
  const createSocket = options.createSocket ?? browserSocket;
  const currentWatch = () =>
    typeof options.watch === "function" ? options.watch() : options.watch;

  let stopped = false;
  let socket: FeedSocket | null = null;
  let opened = false;
  let stopPoll: (() => void) | null = null;
  let lastDataAt: number | null = null;
  let unavailable = false;
  let reconnectFailures = 0;
  let reconnectTimer: unknown = null;
  let checkTimer: unknown = null;

  const onStream = () =>
    socket !== null &&
    !unavailable &&
    lastDataAt !== null &&
    now() - lastDataAt < LIVE_STREAM_SILENCE_MS;

  // The poll runs while the stream does not deliver, and slowly alongside it when `refreshMs` is set.
  let pollPace: number | null = null;
  const balance = () => {
    if (stopped) return;
    const wanted = onStream() ? (options.refreshMs ?? null) : options.poll.intervalMs;
    if (wanted === pollPace) return;
    stopPoll?.();
    stopPoll = null;
    pollPace = wanted;
    if (wanted === null) return;
    stopPoll = startLivePoll({
      ...options.poll,
      intervalMs: wanted,
      page: options.poll.page ?? options.page,
      timers: options.poll.timers ?? options.timers,
    });
  };

  const clearReconnect = () => {
    if (reconnectTimer !== null) timers.clear(reconnectTimer);
    reconnectTimer = null;
  };

  const closeSocket = () => {
    const closing = socket;
    socket = null;
    lastDataAt = null;
    unavailable = false;
    opened = false;
    try {
      closing?.close();
    } catch {
      // Already closed.
    }
  };

  const scheduleReconnect = () => {
    clearReconnect();
    if (stopped || page.visibilityState !== "visible") return;
    const delay = Math.min(
      LIVE_STREAM_BACKOFF_BASE_MS * 2 ** reconnectFailures,
      LIVE_STREAM_BACKOFF_MAX_MS,
    );
    reconnectFailures += 1;
    reconnectTimer = timers.set(open, delay);
  };

  function open() {
    reconnectTimer = null;
    if (stopped || socket !== null || page.visibilityState !== "visible") return;
    let created: FeedSocket;
    try {
      created = createSocket(LIVE_SOCKET_PATH);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = created;
    opened = false;
    // A socket that ended, or a newer one that replaced it, is not this one's business.
    const current = () => socket === created;
    const ended = () => {
      if (!current()) return;
      closeSocket();
      balance();
      scheduleReconnect();
    };
    created.addEventListener("open", () => {
      if (!current()) return;
      opened = true;
      created.send(JSON.stringify(currentWatch()));
    });
    created.addEventListener("message", (event) => {
      if (!current()) return;
      const message = parseLiveMessage(event.data);
      if (message === null) return;
      if (message.type === "state") {
        unavailable = message.state === "unavailable";
      } else {
        lastDataAt = now();
        unavailable = false;
        reconnectFailures = 0;
      }
      options.onMessage(message);
      balance();
    });
    created.addEventListener("close", ended);
    created.addEventListener("error", ended);
  }

  // Silence is noticed here, not by an event: nothing arrives to say that nothing arrives.
  const check = () => {
    checkTimer = timers.set(check, 1000);
    balance();
  };

  const onVisibility = () => {
    if (stopped) return;
    if (page.visibilityState === "visible") {
      reconnectFailures = 0;
      open();
    } else {
      clearReconnect();
      closeSocket();
      balance();
    }
  };

  page.addEventListener("visibilitychange", onVisibility);
  balance();
  open();
  check();
  const stopFeed = () => {
    stopped = true;
    page.removeEventListener("visibilitychange", onVisibility);
    clearReconnect();
    if (checkTimer !== null) timers.clear(checkTimer);
    closeSocket();
    stopPoll?.();
    stopPoll = null;
    pollPace = null;
  };
  // Only an open socket can take it; a socket still connecting sends the current watch on open.
  const rewatch = () => {
    if (socket !== null && opened) socket.send(JSON.stringify(currentWatch()));
  };
  return Object.assign(stopFeed, { rewatch });
}

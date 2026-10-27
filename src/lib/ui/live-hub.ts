// The one live-price socket of the signed-in app (D47). The app layout opens it as soon as the page
// is up and keeps it across client-side navigation; each screen only says what it watches, and the
// hub sends the union to the engine. Messages go to every screen that listens; each one keeps what
// is its own.

import { LIVE_STREAM_BACKOFF_BASE_MS, LIVE_STREAM_BACKOFF_MAX_MS } from "#lib/domain/config.ts";
import type { LiveMessage, WatchEntry, WatchMessage } from "#lib/domain/live-protocol.ts";
import type { LivePollPage, LivePollTimers } from "./live-poll.ts";

/** The part of a browser WebSocket the hub uses. */
export interface FeedSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "close" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

export const LIVE_SOCKET_PATH = "/operar/en-vivo";

export interface LiveHubOptions {
  readonly createSocket?: (path: string) => FeedSocket;
  readonly page?: LivePollPage;
  readonly timers?: LivePollTimers;
  readonly now?: () => number;
  /** Narrows a socket's text to a message; anything else is ignored. */
  readonly parse: (text: unknown) => LiveMessage | null;
}

/** A screen listening to the socket. */
export interface HubListener {
  /** What the screen watches; read each time the union is sent. */
  readonly watch: () => WatchMessage;
  readonly onMessage: (message: LiveMessage) => void;
  /** The socket ended or was closed: nothing arrives until it is back. */
  readonly onDown: () => void;
}

export interface LiveHub {
  /** Keeps the socket open (without watching anything) until the returned function is called. */
  retain(): () => void;
  /** Adds a screen: keeps the socket open, sends the new union and returns the way out. */
  listen(listener: HubListener): () => void;
  /** Sends the union again, after a screen's watch changed. */
  rewatch(): void;
  /** The socket exists (connecting or open). */
  readonly connected: boolean;
  /** The engine's last word: this socket gets no ticks. */
  readonly unavailable: boolean;
}

const BROWSER_TIMERS: LivePollTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function browserSocket(path: string): FeedSocket {
  const url = new URL(path, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(url);
}

/** One watch for the socket: the latest entry any screen has, and every symbol any screen follows. */
export function mergeWatches(watches: ReadonlyArray<WatchMessage>): WatchMessage {
  let entry: WatchEntry | undefined;
  const symbols = new Set<string>();
  for (const watch of watches) {
    if (watch.entry !== undefined) entry = watch.entry;
    for (const symbol of watch.symbols ?? []) symbols.add(symbol);
  }
  return {
    type: "watch",
    ...(entry === undefined ? {} : { entry }),
    ...(symbols.size === 0 ? {} : { symbols: [...symbols] }),
  };
}

export function createLiveHub(options: LiveHubOptions): LiveHub {
  const page = options.page ?? document;
  const timers = options.timers ?? BROWSER_TIMERS;
  const now = options.now ?? Date.now;
  const createSocket = options.createSocket ?? browserSocket;

  const listeners = new Set<HubListener>();
  let retained = 0;
  let socket: FeedSocket | null = null;
  let opened = false;
  let openedAt = 0;
  let unavailable = false;
  let reconnectFailures = 0;
  let reconnectTimer: unknown = null;

  const clearReconnect = () => {
    if (reconnectTimer !== null) timers.clear(reconnectTimer);
    reconnectTimer = null;
  };

  let lastSent: string | null = null;
  const sendWatch = () => {
    if (socket === null || !opened) return;
    lastSent = JSON.stringify(mergeWatches([...listeners].map((listener) => listener.watch())));
    socket.send(lastSent);
  };

  // A screen that goes away and the next one that comes in change the union within one flush, so
  // the engine hears the result once, and not at all when it is what it already watches.
  let sendPending = false;
  const sendSoon = () => {
    if (sendPending) return;
    sendPending = true;
    queueMicrotask(() => {
      sendPending = false;
      if (socket === null || !opened) return;
      const union = JSON.stringify(mergeWatches([...listeners].map((l) => l.watch())));
      if (union !== lastSent) sendWatch();
    });
  };

  const closeSocket = () => {
    const closing = socket;
    if (closing === null) return;
    socket = null;
    opened = false;
    unavailable = false;
    try {
      closing.close();
    } catch {
      // Already closed.
    }
    for (const listener of [...listeners]) listener.onDown();
  };

  const scheduleReconnect = () => {
    clearReconnect();
    if (retained === 0 || page.visibilityState !== "visible") return;
    const delay = Math.min(
      LIVE_STREAM_BACKOFF_BASE_MS * 2 ** reconnectFailures,
      LIVE_STREAM_BACKOFF_MAX_MS,
    );
    reconnectFailures += 1;
    reconnectTimer = timers.set(open, delay);
  };

  function open() {
    reconnectTimer = null;
    if (retained === 0 || socket !== null || page.visibilityState !== "visible") return;
    let created: FeedSocket;
    try {
      created = createSocket(LIVE_SOCKET_PATH);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = created;
    opened = false;
    lastSent = null;
    // A socket that ended, or a newer one that replaced it, is not this one's business.
    const current = () => socket === created;
    const ended = () => {
      if (!current()) return;
      // A socket that lived a long while (the engine renews them) says nothing about the network.
      if (opened && now() - openedAt >= LIVE_STREAM_BACKOFF_MAX_MS) reconnectFailures = 0;
      closeSocket();
      scheduleReconnect();
    };
    created.addEventListener("open", () => {
      if (!current()) return;
      opened = true;
      openedAt = now();
      sendWatch();
    });
    created.addEventListener("message", (event) => {
      if (!current()) return;
      const message = options.parse(event.data);
      if (message === null) return;
      if (message.type === "state") unavailable = message.state === "unavailable";
      else {
        unavailable = false;
        reconnectFailures = 0;
      }
      for (const listener of [...listeners]) listener.onMessage(message);
    });
    created.addEventListener("close", ended);
    created.addEventListener("error", ended);
  }

  const onVisibility = () => {
    if (retained === 0) return;
    if (page.visibilityState === "visible") {
      reconnectFailures = 0;
      open();
    } else {
      clearReconnect();
      closeSocket();
    }
  };

  const retain = () => {
    retained += 1;
    if (retained === 1) {
      page.addEventListener("visibilitychange", onVisibility);
      open();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      retained -= 1;
      if (retained > 0) return;
      page.removeEventListener("visibilitychange", onVisibility);
      clearReconnect();
      closeSocket();
    };
  };

  return {
    retain,
    listen(listener) {
      listeners.add(listener);
      const release = retain();
      sendSoon();
      return () => {
        if (!listeners.delete(listener)) return;
        release();
        // Still open for others: tell the engine what is no longer watched.
        sendSoon();
      };
    },
    rewatch: sendWatch,
    get connected() {
      return socket !== null;
    },
    get unavailable() {
      return unavailable;
    },
  };
}

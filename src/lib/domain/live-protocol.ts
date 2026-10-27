// What the browser and the client's Durable Object say to each other over the live-price socket
// (D47). Prices are display only: nothing here carries a price, SIZE or quantity from the browser.
// The browser names what it watches; the engine answers with what it read from the broker.

import type { SizeChoice } from "./sizing.ts";

/** Tickers and option symbols as TradeStation writes them (an option has spaces: `F 261030C12`). */
export const WATCH_SYMBOL = /^[A-Z0-9][A-Z0-9./ -]{0,31}$/;

export interface WatchEntry {
  readonly accountId: string;
  readonly symbol: string;
  readonly assetType: "equity" | "option";
  /** The client's one-entry SIZE choice (D51). Left out for the full SIZE, so an engine that predates it refuses the watch instead of ignoring it. */
  readonly sizeChoice?: SizeChoice;
}

/** Replaces everything the socket watched so far. An empty watch stops the stream for this screen. */
export interface WatchMessage {
  readonly type: "watch";
  /** The entry on Nueva entrada: the engine sizes it again on every tick. */
  readonly entry?: WatchEntry;
  /** Other symbols to follow, such as the contracts of the chain rows on screen. */
  readonly symbols?: ReadonlyArray<string>;
}

export type EntryUpdate =
  | {
      readonly status: "ready";
      readonly symbol: string;
      readonly assetType: "equity" | "option";
      readonly qty: number;
      readonly sizeMicros: number;
      /** The choice the engine applied: the page refuses an answer for another one (deploy skew). */
      readonly sizeChoice: SizeChoice;
      readonly askMicros: number;
    }
  /** Engine block codes (`EntryBlockCode`); the page words them with `blockMessage`. */
  | { readonly status: "blocked"; readonly reasons: ReadonlyArray<string> };

export type LiveMessage =
  /** `unavailable`: this socket will get no ticks, so the page keeps polling. */
  | { readonly type: "state"; readonly state: "live" | "unavailable" }
  | { readonly type: "entry"; readonly update: EntryUpdate; readonly receivedAt: number }
  | {
      readonly type: "quote";
      readonly symbol: string;
      readonly bid: number | null;
      readonly ask: number | null;
      readonly receivedAt: number;
    }
  /** The broker's heartbeat: nothing changed, the prices on screen are still current. */
  | { readonly type: "alive"; readonly receivedAt: number };

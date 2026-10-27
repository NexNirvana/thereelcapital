// What the live chain endpoint (/operar/cadena/cotizaciones) answers and how the chain screen reads
// it, by polling (D46) or from the socket's pushes (D47). The prices are display only: choosing a
// contract carries just its symbol.

import type { LiveMessage } from "#lib/domain/live-protocol.ts";

export interface ChainSide {
  readonly symbol: string;
  readonly bid: number;
  readonly ask: number;
}

export interface ChainStrike {
  readonly strike: number;
  readonly call: ChainSide | null;
  readonly put: ChainSide | null;
}

export interface LiveChain {
  readonly receivedAt: number;
  /** The underlying's price, kept live like the rows (D47); null when TradeStation gave none. */
  readonly underlyingPrice?: number | null;
  readonly strikes: ReadonlyArray<ChainStrike>;
}

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function parseSide(value: unknown): ChainSide | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object") return undefined;
  const { symbol, bid, ask } = value as Record<string, unknown>;
  return typeof symbol === "string" && isNumber(bid) && isNumber(ask)
    ? { symbol, bid, ask }
    : undefined;
}

/** Narrows the endpoint's JSON; anything else is `null`, shown as no update rather than a guess. */
export function parseLiveChain(body: unknown): LiveChain | null {
  if (typeof body !== "object" || body === null) return null;
  const { status, chain } = body as Record<string, unknown>;
  if (status !== "ready" || typeof chain !== "object" || chain === null) return null;
  const { receivedAt, strikes, underlyingPrice } = chain as Record<string, unknown>;
  if (!isNumber(receivedAt) || !Array.isArray(strikes)) return null;
  const parsed: ChainStrike[] = [];
  for (const row of strikes as unknown[]) {
    if (typeof row !== "object" || row === null) return null;
    const { strike, call, put } = row as Record<string, unknown>;
    const callSide = parseSide(call);
    const putSide = parseSide(put);
    if (!isNumber(strike) || callSide === undefined || putSide === undefined) return null;
    parsed.push({ strike, call: callSide, put: putSide });
  }
  return isNumber(underlyingPrice)
    ? { receivedAt, underlyingPrice, strikes: parsed }
    : { receivedAt, strikes: parsed };
}

/** One read of the endpoint: the chain, or `null` when it could not be read. */
export async function readLiveChain(
  href: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<LiveChain | null> {
  try {
    const response = await fetcher(href, { headers: { accept: "application/json" }, signal });
    return response.ok ? parseLiveChain(await response.json()) : null;
  } catch {
    return null;
  }
}

/** The contracts on screen, which the socket is asked to follow. */
export function chainSymbols(chain: LiveChain): string[] {
  return chain.strikes
    .flatMap((row) => [row.call?.symbol, row.put?.symbol])
    .filter((symbol): symbol is string => symbol !== undefined);
}

/** Where a contract sits in the chain: its strike's position and which side of it. */
export type ChainIndex = ReadonlyMap<
  string,
  { readonly row: number; readonly side: "call" | "put" }
>;

/**
 * Indexes the contracts of the last full read by symbol, so a tick finds its row without scanning
 * the chain. A side that lost its market on screen (null) is still indexed there, which is why the
 * index comes from the full read and not from what is shown.
 */
export function indexChain(reference: LiveChain): ChainIndex {
  const index = new Map<string, { row: number; side: "call" | "put" }>();
  reference.strikes.forEach((row, position) => {
    if (row.call !== null) index.set(row.call.symbol, { row: position, side: "call" });
    if (row.put !== null) index.set(row.put.symbol, { row: position, side: "put" });
  });
  return index;
}

/**
 * What a run of pushed messages (in the order they arrived) does to the chain on screen: the new
 * chain, or `null` when none of them is about the chain. Ticks apply in order, so the last one of a
 * symbol wins; each one touches only its own row, and the rows are copied once for the whole run. A
 * contract that loses one side of its market is shown as missing, never as 0 (like the snapshot).
 * `reference` is the last full read, which names every contract on screen. A side that had no
 * market in it is not watched; the page's slow full read (`refreshMs` of the feed) brings it in.
 * The underlying's own tick moves the price line: the middle of its bid and ask (a pushed quote has
 * no last trade); with no two-sided market it leaves the price alone.
 */
export function chainFromMessages(
  chain: LiveChain,
  messages: ReadonlyArray<LiveMessage>,
  reference: ChainIndex,
  underlying: string,
): LiveChain | null {
  let strikes: ChainStrike[] | null = null;
  let receivedAt = chain.receivedAt;
  let underlyingPrice = chain.underlyingPrice;
  let touched = false;
  for (const message of messages) {
    if (message.type === "alive") {
      receivedAt = message.receivedAt;
      touched = true;
      continue;
    }
    if (message.type !== "quote") continue;
    touched = true;
    receivedAt = message.receivedAt;
    const { symbol, bid, ask } = message;
    if (symbol === underlying && bid !== null && ask !== null) {
      underlyingPrice = Math.round((bid + ask) / 2);
      continue;
    }
    const hit = reference.get(symbol);
    if (hit === undefined) continue;
    strikes ??= chain.strikes.slice();
    const row = strikes[hit.row];
    if (row === undefined) continue;
    const side = bid === null || ask === null ? null : { symbol, bid, ask };
    strikes[hit.row] = hit.side === "call" ? { ...row, call: side } : { ...row, put: side };
  }
  if (!touched) return null;
  const next = { ...chain, receivedAt, strikes: strikes ?? chain.strikes };
  return underlyingPrice === undefined ? next : { ...next, underlyingPrice };
}

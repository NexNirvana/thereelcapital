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

const sideWith = (side: ChainSide | null, bid: number | null, ask: number | null) =>
  side === null || bid === null || ask === null ? null : { symbol: side.symbol, bid, ask };

/**
 * What a pushed message does to the chain on screen: the new chain, or `null` for no change. A
 * contract that loses one side of its market is shown as missing, never as 0 (like the snapshot).
 * `reference` is the last full read, which names every contract on screen. A side that had no
 * market in it is not watched; the page's slow full read (`refreshMs` of the feed) brings it in.
 */
export function chainFromMessage(
  chain: LiveChain,
  message: LiveMessage,
  reference: LiveChain,
): LiveChain | null {
  if (message.type === "alive") return { ...chain, receivedAt: message.receivedAt };
  if (message.type !== "quote") return null;
  const { symbol, bid, ask, receivedAt } = message;
  let changed = false;
  const strikes = chain.strikes.map((row, index) => {
    // Matched against the last full read, because a side that lost its market on screen (null)
    // must still be recognized when its market comes back.
    const known = reference.strikes[index];
    const callHit = known?.call?.symbol === symbol;
    const putHit = known?.put?.symbol === symbol;
    if (!callHit && !putHit) return row;
    changed = true;
    return {
      ...row,
      call: callHit ? sideWith(known?.call ?? null, bid, ask) : row.call,
      put: putHit ? sideWith(known?.put ?? null, bid, ask) : row.put,
    };
  });
  return changed ? { ...chain, receivedAt, strikes } : { ...chain, receivedAt };
}

/**
 * The underlying's own tick moves the price line: the middle of its bid and ask (a pushed quote has
 * no last trade). `null` for any other message, or when the underlying has no two-sided market.
 */
export function chainWithUnderlying(
  chain: LiveChain,
  message: LiveMessage,
  underlying: string,
): LiveChain | null {
  if (message.type !== "quote" || message.symbol !== underlying) return null;
  if (message.bid === null || message.ask === null) return null;
  return {
    ...chain,
    receivedAt: message.receivedAt,
    underlyingPrice: Math.round((message.bid + message.ask) / 2),
  };
}

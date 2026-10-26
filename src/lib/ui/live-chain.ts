// What the live chain endpoint (/operar/cadena/cotizaciones) answers and how the chain screen reads
// it. The prices are display only (D46): choosing a contract carries just its symbol.

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
  const { receivedAt, strikes } = chain as Record<string, unknown>;
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
  return { receivedAt, strikes: parsed };
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

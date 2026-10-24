// Symbol details change at most when the exchange reslices a contract, so one fetch per symbol
// serves a whole market day. In memory only (the Durable Object's storage is the key, so a client
// never sees another client's map) and dropped when the New York session day changes; only a
// successful read is kept, so a rejection or an outage is asked again next time.

import { sessionDate } from "#lib/domain/calendar.ts";
import type { BrokerAdapterShape, SymbolDetails } from "./broker/adapter.ts";
import { attempt, type Attempt } from "./broker/attempt.ts";

interface DetailsCache {
  readonly day: string;
  readonly bySymbol: Map<string, SymbolDetails>;
}

const caches = new WeakMap<DurableObjectStorage, DetailsCache>();

export interface DetailsContext {
  readonly storage: DurableObjectStorage;
  readonly broker: BrokerAdapterShape;
  readonly now: number;
}

export async function cachedSymbolDetails(
  ctx: DetailsContext,
  symbol: string,
): Promise<Attempt<SymbolDetails>> {
  const day = sessionDate(new Date(ctx.now));
  let cache = caches.get(ctx.storage);
  if (cache === undefined || cache.day !== day) {
    cache = { day, bySymbol: new Map() };
    caches.set(ctx.storage, cache);
  }
  const known = cache.bySymbol.get(symbol);
  if (known !== undefined) return { ok: true, value: known };

  const found = await attempt(ctx.broker.symbolDetails(symbol));
  if (found.ok) cache.bySymbol.set(symbol, found.value);
  return found;
}

// The option chain the screen at /operar/cadena shows: expirations, then the strikes of one
// expiration with the CALL and PUT market of each (docs/screens-and-flows.md). Read-only: the
// browser picks an underlying and an expiration and nothing else; the symbol of a contract always
// comes back from the broker, never from the client.

import { Effect } from "effect";
import type { BrokerAdapterShape, ChainRow, Quote } from "./broker/adapter.ts";
import type { BrokerError } from "./broker/errors.ts";
import { CHAIN_STRIKES_CACHE_MS } from "#lib/domain/config.ts";
import { logEvent } from "./events.ts";
import { cachedSymbolDetails } from "./symbol-details.ts";
import { failure, success, type EngineResult } from "./rpc.ts";
import { MISSING_SCOPE_CODE } from "./tradestation/http.ts";

/** The strikes of one expiration as last listed, kept in memory by the Durable Object. */
export type StrikesCache = Map<
  string,
  { readonly at: number; readonly strikes: ReadonlyArray<number> }
>;

interface ChainContext {
  readonly sql: SqlStorage;
  readonly storage: DurableObjectStorage;
  readonly broker: BrokerAdapterShape;
  readonly now: number;
}

/** One side of a strike. A side with no two-sided market is `null`: shown as missing, never as 0. */
export interface ChainQuote {
  readonly symbol: string;
  readonly bid: number;
  readonly ask: number;
}

export interface ChainStrike {
  /** Micro-dollars, like every price. */
  readonly strike: number;
  readonly call: ChainQuote | null;
  readonly put: ChainQuote | null;
}

export interface OptionChain {
  readonly underlying: string;
  readonly expiration: string;
  /** When the engine read the snapshot (epoch ms): the page derives the age from it. */
  readonly receivedAt: number;
  /**
   * TradeStation's last trade of the underlying, or the middle of its bid and ask, in micro-dollars.
   * `null` when the quote could not be read: the screen then draws no price line and shades nothing.
   */
  readonly underlyingPrice: number | null;
  readonly strikes: ReadonlyArray<ChainStrike>;
}

export interface OptionContractView {
  readonly symbol: string;
  readonly underlying: string;
  readonly expiration: string;
  readonly strike: number;
  readonly right: "call" | "put";
}

async function attempt<A>(
  effect: Effect.Effect<A, BrokerError>,
): Promise<{ ok: true; value: A } | { ok: false; error: BrokerError }> {
  const result = await Effect.runPromise(Effect.result(effect));
  return result._tag === "Success"
    ? { ok: true, value: result.success }
    : { ok: false, error: result.failure };
}

/** A broker refusal means "no such underlying/contract"; anything else is the broker being unreachable. */
function brokerFailure(
  ctx: ChainContext,
  operation: string,
  error: BrokerError,
): EngineResult<never> {
  logEvent(ctx, error._tag === "Rejected" ? "info" : "warn", `chain.${operation}_failed`, {
    failure: error._tag,
  });
  if (error._tag === "Rejected" && error.code === MISSING_SCOPE_CODE) {
    return failure("RECONNECT_REQUIRED");
  }
  return failure(error._tag === "Rejected" ? "NOT_FOUND" : "BROKER_UNAVAILABLE");
}

export async function optionExpirations(
  ctx: ChainContext,
  args: { readonly underlying: string },
): Promise<EngineResult<{ underlying: string; expirations: ReadonlyArray<string> }>> {
  const expirations = await attempt(ctx.broker.optionExpirations(args.underlying));
  if (!expirations.ok) return brokerFailure(ctx, "expirations", expirations.error);
  return success({ underlying: args.underlying, expirations: expirations.value });
}

function sideOf(rows: ReadonlyArray<ChainRow>, right: "call" | "put"): ChainQuote | null {
  const row = rows.find((candidate) => candidate.right === right);
  return row === undefined ? null : { symbol: row.symbol, bid: row.bid, ask: row.ask };
}

function priceOf(quotes: ReadonlyArray<Quote>, symbol: string): number | null {
  const quote = quotes.find((candidate) => candidate.symbol === symbol);
  if (quote === undefined) return null;
  if (quote.last !== null) return quote.last;
  return quote.bid !== null && quote.ask !== null ? Math.round((quote.bid + quote.ask) / 2) : null;
}

/** Every listed strike appears; a side the snapshot has no market for stays `null`. */
export async function optionChain(
  // `stamp` reads the engine clock again once the broker answered: the snapshot's age counts from then.
  ctx: ChainContext & { readonly stamp: () => number; readonly strikesCache?: StrikesCache },
  args: { readonly underlying: string; readonly expiration: string },
): Promise<EngineResult<OptionChain>> {
  const { underlying, expiration } = args;
  // The screen reads the chain again every few seconds (D46): the strikes of an expiration are
  // listed once per `CHAIN_STRIKES_CACHE_MS` and each later read costs only the quotes.
  const cacheKey = `${underlying} ${expiration}`;
  const cached = ctx.strikesCache?.get(cacheKey);
  const fresh = cached !== undefined && ctx.now - cached.at < CHAIN_STRIKES_CACHE_MS;
  const strikes = fresh
    ? { ok: true as const, value: cached.strikes }
    : await attempt(ctx.broker.optionStrikes(underlying, expiration));
  if (!strikes.ok) return brokerFailure(ctx, "strikes", strikes.error);
  // The listing's age counts from when it was listed, so polling never keeps it alive.
  if (!fresh) ctx.strikesCache?.set(cacheKey, { at: ctx.now, strikes: strikes.value });
  const [snapshot, underlyingQuote] = await Promise.all([
    attempt(ctx.broker.chainSnapshot(underlying, expiration, strikes.value)),
    // Best effort: a chain without the price is still a chain.
    attempt(ctx.broker.quotes([underlying])),
  ]);
  if (!snapshot.ok) return brokerFailure(ctx, "snapshot", snapshot.error);

  // Only the asked expiration is shown, whatever else a broker (or the local simulator) returns.
  const rows = snapshot.value.filter((row) => row.expiration === expiration);
  const listed = [...new Set([...strikes.value, ...rows.map((row) => row.strike)])].sort(
    (a, b) => a - b,
  );
  return success({
    underlying,
    expiration,
    receivedAt: ctx.stamp(),
    underlyingPrice: underlyingQuote.ok ? priceOf(underlyingQuote.value, underlying) : null,
    strikes: listed.map((strike) => {
      const atStrike = rows.filter((row) => row.strike === strike);
      return { strike, call: sideOf(atStrike, "call"), put: sideOf(atStrike, "put") };
    }),
  });
}

/** What an option symbol stands for, so /operar can show the underlying and the contract apart. */
export async function optionContract(
  ctx: ChainContext,
  args: { readonly symbol: string },
): Promise<EngineResult<OptionContractView>> {
  const details = await cachedSymbolDetails(ctx, args.symbol);
  if (!details.ok) return brokerFailure(ctx, "contract", details.error);
  const { option } = details.value;
  if (option === null) return failure("NOT_FOUND");
  return success({ symbol: args.symbol, ...option });
}

// The option chain the screen at /operar/cadena shows: expirations, then the strikes of one
// expiration with the CALL and PUT market of each (docs/screens-and-flows.md). Read-only: the
// browser picks an underlying and an expiration and nothing else; the symbol of a contract always
// comes back from the broker, never from the client.

import { Effect } from "effect";
import type { BrokerAdapterShape, ChainRow } from "./broker/adapter.ts";
import type { BrokerError } from "./broker/errors.ts";
import { logEvent } from "./events.ts";
import { cachedSymbolDetails } from "./symbol-details.ts";
import { failure, success, type EngineResult } from "./rpc.ts";
import { MISSING_SCOPE_CODE } from "./tradestation/http.ts";

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

/** Every listed strike appears; a side the snapshot has no market for stays `null`. */
export async function optionChain(
  // `stamp` reads the engine clock again once the broker answered: the snapshot's age counts from then.
  ctx: ChainContext & { readonly stamp: () => number },
  args: { readonly underlying: string; readonly expiration: string },
): Promise<EngineResult<OptionChain>> {
  const { underlying, expiration } = args;
  const [strikes, snapshot] = await Promise.all([
    attempt(ctx.broker.optionStrikes(underlying, expiration)),
    attempt(ctx.broker.chainSnapshot(underlying, expiration)),
  ]);
  if (!strikes.ok) return brokerFailure(ctx, "strikes", strikes.error);
  if (!snapshot.ok) return brokerFailure(ctx, "snapshot", snapshot.error);

  // The chain stream may carry other expirations; this screen shows the one it was asked for.
  const rows = snapshot.value.filter((row) => row.expiration === expiration);
  const listed = [...new Set([...strikes.value, ...rows.map((row) => row.strike)])].sort(
    (a, b) => a - b,
  );
  return success({
    underlying,
    expiration,
    receivedAt: ctx.stamp(),
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

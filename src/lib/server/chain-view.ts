import {
  choiceFor,
  defaultExpiration,
  fallbackNotice,
  resolveExpiration,
  suggestionLabel,
} from "#lib/ui/expiration-field.ts";
import type { ChainView } from "#lib/ui/chain-view.ts";
import { UNDERLYING } from "./chain-query.ts";

export type ChainEngine = DurableObjectStub<import("../../../engine/src/index").ClientCoordinator>;

const UNAVAILABLE = "No pudimos comunicarnos con TradeStation. Inténtalo de nuevo.";

/**
 * What the Opciones tab shows for a typed underlying and Vencimiento text: the listed expirations
 * and the chain of the one the server decided on. Nothing the browser typed is trusted: the date is
 * resolved against the listed ones here, and the engine validates the rest.
 */
export async function loadChainView(
  engine: ChainEngine,
  underlying: string,
  typedExpiration: string,
  now: Date,
): Promise<ChainView> {
  const base: ChainView = {
    underlying,
    expiration: "",
    expirationText: typedExpiration,
    nowMs: now.getTime(),
    choice: null,
    notice: null,
    expirations: null,
    chain: null,
    problem: null,
  };
  if (underlying === "") return base;
  if (!UNDERLYING.test(underlying)) {
    return { ...base, problem: "Escribe el ticker de un subyacente, por ejemplo MSFT." };
  }

  const expirations = await engine.optionExpirations({ mode: "SIM", underlying }).catch(() => null);
  if (expirations === null) return { ...base, problem: UNAVAILABLE };
  if (!expirations.ok) return { ...base, problem: expirations.message };
  const shown = { ...base, expirations: expirations.value.expirations };

  let expiration: string;
  let notice: string | null = null;
  if (typedExpiration === "") {
    const chosen = defaultExpiration(shown.expirations, now);
    if (chosen === null) return shown;
    expiration = chosen.date;
    if (!chosen.isToday) notice = fallbackNotice(underlying, chosen.date);
  } else {
    const found = resolveExpiration(shown.expirations, typedExpiration, now);
    if (found.kind !== "found") {
      // «Empty» cannot happen here: blank text took the default above.
      return { ...shown, choice: choiceFor(found, typedExpiration) };
    }
    expiration = found.date;
  }
  const decided = {
    ...shown,
    expiration,
    expirationText: suggestionLabel(expiration, now),
    notice,
  };

  const chain = await engine.optionChain({ mode: "SIM", underlying, expiration }).catch(() => null);
  if (chain === null) return { ...decided, problem: UNAVAILABLE };
  if (!chain.ok) return { ...decided, problem: chain.message };
  const { receivedAt, underlyingPrice, strikes } = chain.value;
  return { ...decided, chain: { receivedAt, underlyingPrice, strikes } };
}

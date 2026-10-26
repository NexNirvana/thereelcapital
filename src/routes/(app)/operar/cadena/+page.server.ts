import { redirect } from "@sveltejs/kit";
import { resolve } from "$app/paths";
import { env } from "cloudflare:workers";
import { decode } from "#lib/server/decode.ts";
import { ChainQuery, UNDERLYING } from "#lib/server/chain-query.ts";
import { engineFor } from "#lib/server/engine.ts";
import { requireUser } from "#lib/server/guards.ts";
import {
  choiceFor,
  defaultExpiration,
  suggestionLabel,
  fallbackNotice,
  resolveExpiration,
} from "#lib/ui/expiration-field.ts";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async (event) => {
  if (!event.locals.user) redirect(303, resolve("/acceso"));
  requireUser(event);
  // A chain snapshot is a moment in time: never cached or replayed.
  event.setHeaders({ "cache-control": "no-store" });
  // The page refreshes by invalidating this key, so the layout does not rerun.
  event.depends("app:chain");

  const query = decode(ChainQuery, Object.fromEntries(event.url.searchParams));
  const underlying = (query.subyacente ?? "").trim().toUpperCase();
  const typedExpiration = (query.vencimiento ?? "").trim();
  const now = new Date();
  const base = {
    underlying,
    expiration: "",
    // What the Vencimiento field shows, and the clock its labels count from.
    expirationText: typedExpiration,
    nowMs: now.getTime(),
    // Why no expiration was chosen: a lead and the listed dates to pick from.
    choice: null as { lead: string; dates: ReadonlyArray<string> } | null,
    notice: null as string | null,
    accountId: query.cuenta ?? null,
    expirations: null as ReadonlyArray<string> | null,
    chain: null as {
      receivedAt: number;
      strikes: ReadonlyArray<{
        strike: number;
        call: { symbol: string; bid: number; ask: number } | null;
        put: { symbol: string; bid: number; ask: number } | null;
      }>;
    } | null,
    problem: null as string | null,
  };
  if (underlying === "") return base;
  if (!UNDERLYING.test(underlying)) {
    return { ...base, problem: "Escribe el ticker de un subyacente, por ejemplo MSFT." };
  }

  const engine = engineFor(env.ENGINE, event);
  const expirations = await engine.optionExpirations({ mode: "SIM", underlying }).catch(() => null);
  if (expirations === null) {
    return { ...base, problem: "No pudimos comunicarnos con TradeStation. Inténtalo de nuevo." };
  }
  if (!expirations.ok) return { ...base, problem: expirations.message };
  const shown = { ...base, expirations: expirations.value.expirations };

  // The server decides which listed expiration is meant; nothing the browser typed is trusted.
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
  if (chain === null) {
    return { ...decided, problem: "No pudimos comunicarnos con TradeStation. Inténtalo de nuevo." };
  }
  if (!chain.ok) return { ...decided, problem: chain.message };
  return {
    ...decided,
    chain: { receivedAt: chain.value.receivedAt, strikes: chain.value.strikes },
  };
};

import { redirect } from "@sveltejs/kit";
import { resolve } from "$app/paths";
import { env } from "cloudflare:workers";
import { Schema } from "effect";
import { decode } from "#lib/server/decode.ts";
import { engineFor } from "#lib/server/engine.ts";
import { requireUser } from "#lib/server/guards.ts";
import type { PageServerLoad } from "./$types";

// The browser names an underlying, an expiration and (to hand it back) an account. Contract
// symbols, prices and strikes only ever come from the engine; unknown parameters are a 400.
const Query = Schema.Struct({
  subyacente: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16))),
  vencimiento: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(10))),
  cuenta: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
});

const UNDERLYING = /^[A-Z0-9][A-Z0-9./-]{0,15}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const load: PageServerLoad = async (event) => {
  if (!event.locals.user) redirect(303, resolve("/acceso"));
  requireUser(event);
  // A chain snapshot is a moment in time: never cached or replayed.
  event.setHeaders({ "cache-control": "no-store" });
  // The page refreshes by invalidating this key, so the layout does not rerun.
  event.depends("app:chain");

  const query = decode(Query, Object.fromEntries(event.url.searchParams));
  const underlying = (query.subyacente ?? "").trim().toUpperCase();
  const expiration = query.vencimiento ?? "";
  const base = {
    underlying,
    expiration,
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
  if (!UNDERLYING.test(underlying) || (expiration !== "" && !ISO_DATE.test(expiration))) {
    return { ...base, problem: "Escribe el ticker de un subyacente, por ejemplo MSFT." };
  }

  const engine = engineFor(env.ENGINE, event);
  const expirations = await engine.optionExpirations({ mode: "SIM", underlying }).catch(() => null);
  if (expirations === null) {
    return { ...base, problem: "No pudimos comunicarnos con TradeStation. Inténtalo de nuevo." };
  }
  if (!expirations.ok) return { ...base, problem: expirations.message };
  const shown = { ...base, expirations: expirations.value.expirations };
  if (expiration === "") return shown;

  const chain = await engine.optionChain({ mode: "SIM", underlying, expiration }).catch(() => null);
  if (chain === null) {
    return { ...shown, problem: "No pudimos comunicarnos con TradeStation. Inténtalo de nuevo." };
  }
  if (!chain.ok) return { ...shown, problem: chain.message };
  return { ...shown, chain: { receivedAt: chain.value.receivedAt, strikes: chain.value.strikes } };
};

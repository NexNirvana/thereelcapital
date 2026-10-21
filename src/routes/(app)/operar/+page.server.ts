import { redirect } from "@sveltejs/kit";
import { resolve } from "$app/paths";
import { env } from "cloudflare:workers";
import { Schema } from "effect";
import { blockMessage, connectionBlockCode } from "#lib/ui/new-entry.ts";
import { decode } from "#lib/server/decode.ts";
import { engineFor } from "#lib/server/engine.ts";
import { requireUser } from "#lib/server/guards.ts";
import type { PageServerLoad } from "./$types";

// Everything the browser may say about an entry: which tab, which account and which instrument.
// SIZE, quantity and price are not inputs: the engine reads SIZE from the client's settings and the
// ask from TradeStation (CLAUDE.md, never-break rule 3), and unknown fields are rejected.
const Query = Schema.Struct({
  tipo: Schema.optionalKey(Schema.Literals(["acciones", "opciones"])),
  cuenta: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  simbolo: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(32))),
});

/** Equity tickers and option symbols ("MSFT 261120C400"): letters, digits, space, dot, dash, slash. */
const SYMBOL = /^[A-Z0-9][A-Z0-9 ./-]*$/;

const ASSET_TYPE = { acciones: "equity", opciones: "option" } as const;

export const load: PageServerLoad = async (event) => {
  if (!event.locals.user) redirect(303, resolve("/acceso"));
  const { user } = requireUser(event);
  // Quotes and accounts of one client: never cached by a shared proxy.
  event.setHeaders({ "cache-control": "no-store" });

  const query = decode(Query, Object.fromEntries(event.url.searchParams));
  const tipo = query.tipo ?? "acciones";
  const symbol = (query.simbolo ?? "").trim().toUpperCase();

  const engine = engineFor(env.ENGINE, event);
  const [connection, limits, settings] = await Promise.all([
    engine.connection({ mode: "SIM" }).catch(() => null),
    engine.limits({ mode: "SIM" }).catch(() => null),
    env.DB.prepare("SELECT stop_pct FROM client_settings WHERE user_id = ?")
      .bind(user.id)
      .first<{ stop_pct: number }>()
      .catch(() => null),
  ]);

  const base = {
    tipo,
    symbol,
    stopPct: settings?.stop_pct ?? null,
    limits: limits?.ok ? limits.value : null,
    accounts: [] as string[],
    accountId: null as string | null,
  };
  if (connection === null || !connection.ok) {
    return {
      ...base,
      preview: null,
      blocked: connection?.ok === false ? connection.message : "No pudimos leer tu conexión.",
    };
  }
  const view = connection.value;
  if (view.status !== "CONNECTED") {
    return { ...base, preview: null, blocked: blockMessage([connectionBlockCode(view)]) };
  }
  const accounts = view.accounts.map((account) => account.accountId);
  // The engine checks the account really is the client's; here it only has to name one.
  const accountId = query.cuenta ?? accounts[0] ?? null;
  const shown = { ...base, accounts, accountId };
  // A connection can be stored with no Cash or Margin account to trade: say so, not "type a symbol".
  if (accountId === null) return { ...shown, preview: null, blocked: blockMessage(["NO_ACCOUNT"]) };
  if (view.entriesBlocked) {
    return { ...shown, preview: null, blocked: blockMessage([connectionBlockCode(view)]) };
  }
  if (symbol === "") return { ...shown, preview: null, blocked: null };
  if (!SYMBOL.test(symbol)) {
    return { ...shown, preview: null, blocked: blockMessage(["SYMBOL_DETAILS_MISSING"]) };
  }

  const prepared = await engine
    .prepareEntry({ mode: "SIM", accountId, symbol, assetType: ASSET_TYPE[tipo] })
    .catch(() => null);
  if (prepared === null) {
    return { ...shown, preview: null, blocked: "No pudimos comunicarnos con TradeStation." };
  }
  if (!prepared.ok) return { ...shown, preview: null, blocked: prepared.message };
  if (prepared.value.status === "BLOCKED") {
    return { ...shown, preview: null, blocked: blockMessage(prepared.value.reasons) };
  }
  // The intent id stays server-side: the review step asks for its own preview (#26).
  const { symbol: preparedSymbol, qty, sizeMicros, askMicros, assetType } = prepared.value;
  return {
    ...shown,
    blocked: null,
    preview: { symbol: preparedSymbol, qty, sizeMicros, askMicros, assetType },
  };
};

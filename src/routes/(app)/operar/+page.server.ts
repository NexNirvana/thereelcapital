import { redirect } from "@sveltejs/kit";
import { resolve } from "$app/paths";
import { env } from "cloudflare:workers";
import { blockMessage, connectionBlockCode } from "#lib/ui/new-entry.ts";
import { decode } from "#lib/server/decode.ts";
import { ASSET_TYPE, EntryQuery, SYMBOL } from "#lib/server/entry-query.ts";
import { engineFor } from "#lib/server/engine.ts";
import { requireUser } from "#lib/server/guards.ts";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async (event) => {
  const { parent } = event;
  if (!event.locals.user) redirect(303, resolve("/acceso"));
  const { user } = requireUser(event);
  // Quotes and accounts of one client: never cached by a shared proxy.
  event.setHeaders({ "cache-control": "no-store" });

  const query = decode(EntryQuery, Object.fromEntries(event.url.searchParams));
  const tipo = query.tipo ?? "acciones";
  const symbol = (query.simbolo ?? "").trim().toUpperCase();

  const engine = engineFor(env.ENGINE, event);
  // The connection comes from the layout; the other reads start now so they overlap with it.
  const others = Promise.all([
    engine.limits({ mode: "SIM" }).catch(() => null),
    env.DB.prepare("SELECT stop_pct FROM client_settings WHERE user_id = ?")
      .bind(user.id)
      .first<{ stop_pct: number }>()
      .catch(() => null),
    // What the chosen option symbol stands for, so the screen shows the underlying and the
    // contract apart. The symbol came back from the chain; the engine says what it is.
    tipo === "opciones" && SYMBOL.test(symbol)
      ? engine.optionContract({ mode: "SIM", symbol }).catch(() => null)
      : null,
  ]);
  const { connection: shell } = await parent();
  const [limits, settings, contract] = await others;

  const base = {
    tipo,
    symbol,
    stopPct: settings?.stop_pct ?? null,
    limits: limits?.ok ? limits.value : null,
    contract: contract?.ok ? contract.value : null,
    accounts: [] as string[],
    accountId: null as string | null,
  };
  if (!shell?.ok) {
    return {
      ...base,
      preview: null,
      blocked: shell?.ok === false ? shell.message : "No pudimos leer tu conexión.",
    };
  }
  const view = shell.view;
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
  // The intent id stays server-side: the review step (/operar/revisar) asks for its own preview.
  const { symbol: preparedSymbol, qty, sizeMicros, askMicros, assetType } = prepared.value;
  return {
    ...shown,
    blocked: null,
    preview: { symbol: preparedSymbol, qty, sizeMicros, askMicros, assetType },
  };
};

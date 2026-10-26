import { fail, redirect } from "@sveltejs/kit";
import { resolve } from "$app/paths";
import { env } from "cloudflare:workers";
import { Schema } from "effect";
import { blockMessage } from "#lib/ui/new-entry.ts";
import { decode } from "#lib/server/decode.ts";
import { engineFor } from "#lib/server/engine.ts";
import { ASSET_TYPE, EntryQuery, INTENT_ID, SYMBOL } from "#lib/server/entry-query.ts";
import { requireUser } from "#lib/server/guards.ts";
import type { Actions, PageServerLoad } from "./$types";

const back = () => resolve("/(app)/operar");

/** The entry the client asked to review; anything missing sends them back to choose one. */
function target(params: URLSearchParams) {
  // `/enviar` is the form action's own key, not something the client chose.
  const entry = [...params].filter(([name]) => !name.startsWith("/"));
  const query = decode(EntryQuery, Object.fromEntries(entry));
  const symbol = (query.simbolo ?? "").trim().toUpperCase();
  if (query.cuenta === undefined || !SYMBOL.test(symbol)) redirect(303, back());
  return { tipo: query.tipo ?? "acciones", accountId: query.cuenta, symbol } as const;
}

const underlyingOf = (symbol: string) => symbol.split(" ")[0] ?? symbol;

export const load: PageServerLoad = async (event) => {
  if (!event.locals.user) redirect(303, resolve("/acceso"));
  requireUser(event);
  event.setHeaders({ "cache-control": "no-store" });

  const { tipo, accountId, symbol } = target(event.url.searchParams);
  const prepared = await engineFor(env.ENGINE, event)
    .prepareEntry({ mode: "SIM", accountId, symbol, assetType: ASSET_TYPE[tipo] })
    .catch(() => null);
  const base = {
    tipo,
    accountId,
    symbol,
    underlying: underlyingOf(symbol),
    mode: "SIM",
    quotedAt: null as number | null,
  } as const;
  if (prepared === null) {
    return { ...base, preview: null, blocked: "No pudimos comunicarnos con TradeStation." };
  }
  if (!prepared.ok) return { ...base, preview: null, blocked: prepared.message };
  if (prepared.value.status === "BLOCKED") {
    return { ...base, preview: null, blocked: blockMessage(prepared.value.reasons) };
  }
  const { intentId, qty, sizeMicros, askMicros, assetType } = prepared.value;
  return {
    ...base,
    blocked: null,
    preview: { intentId, qty, sizeMicros, askMicros, assetType },
    quotedAt: Date.now(),
  };
};

// The only things a send form carries. SIZE, price and any other field are not read, so adding
// them to the request changes nothing: the engine sizes the order itself and compares `cantidad`
// with its own quantity (CLAUDE.md, never-break rule 3).
const Send = Schema.Struct({
  tipo: Schema.Literals(["acciones", "opciones"]),
  cuenta: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  simbolo: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  intentId: Schema.String.check(Schema.isPattern(INTENT_ID)),
  cantidad: Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0)),
});

const statusHref = (intentId: string) => resolve("/(app)/operar/revisar/[intentId]", { intentId });

export const actions: Actions = {
  enviar: async (event) => {
    requireUser(event);
    const form = await event.request.formData();
    const parsed = Schema.decodeUnknownResult(Send)(
      Object.fromEntries(
        ["tipo", "cuenta", "simbolo", "intentId", "cantidad"].map((name) => [name, form.get(name)]),
      ),
    );
    if (parsed._tag === "Failure") {
      return fail(400, { message: "Los datos enviados no son válidos." });
    }
    const { tipo, cuenta, simbolo, intentId, cantidad } = parsed.success;

    const sent = await engineFor(env.ENGINE, event)
      .sendEntry({
        mode: "SIM",
        accountId: cuenta,
        symbol: simbolo,
        assetType: ASSET_TYPE[tipo],
        intentId,
        confirmedQty: cantidad,
      })
      // The order may have left before the failure: the status page tells what became of it.
      .catch(() => null);
    if (sent === null) redirect(303, statusHref(intentId));
    if (!sent.ok) return fail(422, { message: sent.message });
    const result = sent.value;
    if (result.status === "BLOCKED") return fail(409, { message: blockMessage(result.reasons) });
    if (result.status === "RECONFIRM") {
      const { qty, sizeMicros, askMicros, assetType } = result.preview;
      return { reconfirm: { qty, sizeMicros, askMicros, assetType, previousQty: cantidad } };
    }
    redirect(303, statusHref(result.intentId));
  },
};

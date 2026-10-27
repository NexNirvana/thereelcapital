import { fail, redirect } from "@sveltejs/kit";
import { resolve } from "$app/paths";
import { env } from "cloudflare:workers";
import { Schema } from "effect";
import { blockMessage, connectionBlockCode } from "#lib/ui/new-entry.ts";
import { decode } from "#lib/server/decode.ts";
import {
  ASSET_TYPE,
  INTENT_ID,
  OperarQuery,
  SYMBOL,
  sizeChoiceArg,
} from "#lib/server/entry-query.ts";
import { choiceApplied, SIZE_CHOICES } from "#lib/domain/sizing.ts";
import { SIZE_CHOICE_MISMATCH } from "#lib/ui/live-entry.ts";
import { loadChainView } from "#lib/server/chain-view.ts";
import { engineFor } from "#lib/server/engine.ts";
import { exactStrike, parseStrikeCount } from "#lib/ui/chain-window.ts";
import { requireUser } from "#lib/server/guards.ts";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async (event) => {
  const { parent } = event;
  if (!event.locals.user) redirect(303, resolve("/acceso"));
  const { user } = requireUser(event);
  // Quotes and accounts of one client: never cached by a shared proxy.
  event.setHeaders({ "cache-control": "no-store" });

  // `/enviar` is the send form's own action key, not something the client chose.
  const entry = [...event.url.searchParams].filter(([name]) => !name.startsWith("/"));
  const query = decode(OperarQuery, Object.fromEntries(entry));
  const tipo = query.tipo ?? "acciones";
  // Every new Nueva entrada starts at the full SIZE: the choice lives in this URL only (D51).
  const sizeChoice = query.tamano ?? "full";
  const symbol = (query.simbolo ?? "").trim().toUpperCase();

  const engine = engineFor(env.ENGINE, event);
  // A chain snapshot is a moment in time; the live poll and «Actualizar» read it again.
  event.depends("app:chain");
  const now = new Date();
  const typedUnderlying = (query.subyacente ?? "").trim().toUpperCase();
  const chainOf = (underlying: string, expiration: string) =>
    loadChainView(engine, underlying, expiration, now);
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
    tipo === "opciones" && typedUnderlying !== ""
      ? chainOf(typedUnderlying, (query.vencimiento ?? "").trim())
      : null,
  ]);
  const { connection: shell } = await parent();
  const [limits, settings, contract, typedChain] = await others;
  // A link from before the chain lived in this tab names only the contract: show its chain.
  const chosen = contract?.ok ? contract.value : null;
  const chainView =
    typedChain ?? (chosen === null ? null : await chainOf(chosen.underlying, chosen.expiration));
  const strikes = chainView?.chain?.strikes.map((row) => row.strike) ?? [];
  const typedStrike = query.strike === undefined ? null : exactStrike(strikes, query.strike);

  const base = {
    tipo,
    symbol,
    sizeChoice,
    stopPct: settings?.stop_pct ?? null,
    limits: limits?.ok ? limits.value : null,
    contract: chosen,
    chainView,
    // The strike the table is centered on (typed, or the chosen contract's) and how many to show.
    strike:
      typedStrike ??
      (query.subyacente === undefined && query.strike === undefined
        ? (chosen?.strike ?? null)
        : null),
    strikeCount: parseStrikeCount(query.strikes),
    accounts: [] as string[],
    accountId: null as string | null,
    quotedAt: null as number | null,
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
    .prepareEntry({
      mode: "SIM",
      accountId,
      symbol,
      assetType: ASSET_TYPE[tipo],
      ...sizeChoiceArg(sizeChoice),
    })
    .catch(() => null);
  if (prepared === null) {
    return { ...shown, preview: null, blocked: "No pudimos comunicarnos con TradeStation." };
  }
  if (!prepared.ok) return { ...shown, preview: null, blocked: prepared.message };
  if (prepared.value.status === "BLOCKED") {
    return { ...shown, preview: null, blocked: blockMessage(prepared.value.reasons) };
  }
  // An engine that ignored the choice would show a quantity the order would not follow.
  if (!choiceApplied(sizeChoice, prepared.value.sizeChoice)) {
    return { ...shown, preview: null, blocked: SIZE_CHOICE_MISMATCH };
  }
  // One intent id per page load: every post of this page's send form carries it, so a double
  // click or a repeated post is the same order (docs/order-lifecycle.md).
  const {
    intentId,
    symbol: preparedSymbol,
    qty,
    sizeMicros,
    askMicros,
    assetType,
  } = prepared.value;
  return {
    ...shown,
    blocked: null,
    preview: { intentId, symbol: preparedSymbol, qty, sizeMicros, askMicros, assetType },
    quotedAt: Date.now(),
  };
};

// The only things the send form carries. SIZE, price and any other field are not read, so adding
// them to the request changes nothing: the engine sizes the order itself and compares `cantidad`
// with its own quantity (CLAUDE.md, never-break rule 3).
const Send = Schema.Struct({
  tipo: Schema.Literals(["acciones", "opciones"]),
  cuenta: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  simbolo: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  intentId: Schema.String.check(Schema.isPattern(INTENT_ID)),
  cantidad: Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0)),
  // The choice, never an amount: the engine computes the applied SIZE (D51).
  tamano: Schema.optionalKey(Schema.Literals(SIZE_CHOICES)),
});

const statusHref = (intentId: string) => resolve("/(app)/operar/revisar/[intentId]", { intentId });

export const actions: Actions = {
  enviar: async (event) => {
    requireUser(event);
    const form = await event.request.formData();
    const parsed = Schema.decodeUnknownResult(Send)(
      // A field the form left out is absent, not null: the choice is optional (the full SIZE).
      Object.fromEntries(
        ["tipo", "cuenta", "simbolo", "intentId", "cantidad", "tamano"]
          .map((name) => [name, form.get(name)] as const)
          .filter(([, value]) => value !== null),
      ),
    );
    if (parsed._tag === "Failure") {
      return fail(400, { message: "Los datos enviados no son válidos." });
    }
    const { tipo, cuenta, simbolo, intentId, cantidad } = parsed.success;
    const tamano = parsed.success.tamano ?? "full";

    const sent = await engineFor(env.ENGINE, event)
      .sendEntry({
        mode: "SIM",
        accountId: cuenta,
        symbol: simbolo,
        assetType: ASSET_TYPE[tipo],
        intentId,
        confirmedQty: cantidad,
        ...sizeChoiceArg(tamano),
      })
      // The order may have left before the failure: the status page tells what became of it.
      .catch(() => null);
    if (sent === null) redirect(303, statusHref(intentId));
    if (!sent.ok) return fail(422, { message: sent.message });
    const result = sent.value;
    if (result.status === "BLOCKED") return fail(409, { message: blockMessage(result.reasons) });
    if (result.status === "RECONFIRM") {
      if (!choiceApplied(tamano, result.preview.sizeChoice)) {
        return fail(409, { message: SIZE_CHOICE_MISMATCH });
      }
      const { symbol, qty, sizeMicros, askMicros, assetType } = result.preview;
      return {
        reconfirm: { symbol, qty, sizeMicros, askMicros, assetType, previousQty: cantidad },
      };
    }
    redirect(303, statusHref(result.intentId));
  },
};

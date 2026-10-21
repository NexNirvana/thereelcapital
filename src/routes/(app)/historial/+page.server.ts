import { redirect } from "@sveltejs/kit";
import { resolve } from "$app/paths";
import { env } from "cloudflare:workers";
import { Schema } from "effect";
import { isCalendarDay } from "#lib/domain/calendar.ts";
import { decode } from "#lib/server/decode.ts";
import { engineFor } from "#lib/server/engine.ts";
import { requireUser } from "#lib/server/guards.ts";
import type { PageServerLoad } from "./$types";

// Everything the browser may say about the history: which rows to narrow to and where the next page
// starts. The client id is the session's and the mode is SIM; unknown parameters are a 400.
const Day = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
  Schema.makeFilter(isCalendarDay),
);
const Query = Schema.Struct({
  modo: Schema.optionalKey(Schema.Literal("SIM")),
  cuenta: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  simbolo: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(32))),
  desde: Schema.optionalKey(Schema.Union([Day, Schema.Literal("")])),
  hasta: Schema.optionalKey(Schema.Union([Day, Schema.Literal("")])),
  despues: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^\d{1,16}:[A-Za-z0-9_-]{1,64}$/)),
  ),
});

export const load: PageServerLoad = async (event) => {
  if (!event.locals.user) redirect(303, resolve("/acceso"));
  requireUser(event);
  // One client's orders: never cached by a shared proxy.
  event.setHeaders({ "cache-control": "no-store" });

  const query = decode(Query, Object.fromEntries(event.url.searchParams));
  const filters = {
    cuenta: query.cuenta ?? "",
    simbolo: (query.simbolo ?? "").trim().toUpperCase(),
    desde: query.desde ?? "",
    hasta: query.hasta ?? "",
  };
  const args = {
    mode: "SIM",
    ...(filters.cuenta === "" ? {} : { accountId: filters.cuenta }),
    ...(filters.simbolo === "" ? {} : { symbol: filters.simbolo }),
    ...(filters.desde === "" ? {} : { from: filters.desde }),
    ...(filters.hasta === "" ? {} : { to: filters.hasta }),
    ...(query.despues === undefined ? {} : { cursor: query.despues }),
  };

  const result = await engineFor(env.ENGINE, event)
    .history(args)
    .catch(() => null);
  const filtered = Object.values(filters).some((value) => value !== "");
  if (result === null) {
    return {
      filters,
      filtered,
      page: null,
      error: "No pudimos leer tu historial. Inténtalo de nuevo.",
    };
  }
  if (!result.ok) return { filters, filtered, page: null, error: result.message };
  const { intents, events, accounts, nextCursor } = result.value;
  const next = new URLSearchParams(
    Object.entries({ ...filters, despues: nextCursor ?? "" }).filter(([, value]) => value !== ""),
  );
  return {
    filters,
    filtered,
    error: null,
    page: {
      intents,
      events,
      accounts,
      nextQuery: nextCursor === null ? null : next.toString(),
      first: query.despues === undefined,
    },
  };
};

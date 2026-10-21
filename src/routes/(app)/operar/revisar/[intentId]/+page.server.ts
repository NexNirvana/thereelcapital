import { error, redirect } from "@sveltejs/kit";
import { resolve } from "$app/paths";
import { env } from "cloudflare:workers";
import { engineFor } from "#lib/server/engine.ts";
import { INTENT_ID } from "#lib/server/entry-query.ts";
import { requireUser } from "#lib/server/guards.ts";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async (event) => {
  if (!event.locals.user) redirect(303, resolve("/acceso"));
  requireUser(event);
  // The page invalidates this key to poll the engine.
  event.depends("app:order");
  event.setHeaders({ "cache-control": "no-store" });

  const { intentId } = event.params;
  if (!INTENT_ID.test(intentId)) error(404, "No encontramos esa orden.");

  // The engine is this client's own Durable Object, so only their intents can be found.
  const history = await engineFor(env.ENGINE, event)
    .history({ mode: "SIM" })
    .catch(() => null);
  if (history === null || !history.ok) {
    return { intent: null, message: "No pudimos leer el estado de la orden. Inténtalo de nuevo." };
  }
  const row = history.value.intents.find((intent) => intent.id === intentId);
  if (row === undefined) {
    return { intent: null, message: "Todavía no hay registro de esta orden." };
  }
  const { symbol, state, qty, filled_qty } = row;
  if (
    typeof symbol !== "string" ||
    typeof state !== "string" ||
    typeof qty !== "number" ||
    typeof filled_qty !== "number"
  ) {
    return { intent: null, message: "No pudimos leer el estado de la orden. Inténtalo de nuevo." };
  }
  return { intent: { symbol, state, qty, filledQty: filled_qty }, message: null };
};

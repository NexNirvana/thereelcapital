import { fail, redirect } from "@sveltejs/kit";
import { resolve } from "$app/paths";
import { env } from "cloudflare:workers";
import { Schema } from "effect";
import { decode } from "#lib/server/decode.ts";
import { engineFor } from "#lib/server/engine.ts";
import { INTENT_ID } from "#lib/server/entry-query.ts";
import { requireUser } from "#lib/server/guards.ts";
import { cancelOutcome, exitBlockMessage, exitOutcome } from "#lib/ui/positions.ts";
import type { Actions, PageServerLoad } from "./$types";

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64));
// The only thing the browser may say about the view: which open position to show.
const Query = Schema.Struct({ p: Schema.optionalKey(Id) });

export const load: PageServerLoad = async (event) => {
  if (!event.locals.user) redirect(303, resolve("/acceso"));
  requireUser(event);
  // The page invalidates this key to poll the engine.
  event.depends("app:positions");
  event.setHeaders({ "cache-control": "no-store" });

  // Only `p` is read: without JavaScript the form action's own name (`/salir`) is a search key too.
  const p = event.url.searchParams.get("p");
  const query = decode(Query, p === null ? {} : { p });
  const result = await engineFor(env.ENGINE, event)
    .positions({ mode: "SIM" })
    .catch(() => null);
  if (result === null || !result.ok) {
    return {
      view: null,
      selectedId: null,
      error: "No pudimos leer tus posiciones. Inténtalo de nuevo.",
    };
  }
  const { positions } = result.value;
  // An unknown or closed id falls back to the first open position.
  const selected = positions.find((position) => position.id === query.p) ?? positions[0];
  return { view: result.value, selectedId: selected?.id ?? null, error: null };
};

// What a sell form carries: a position id and a step (or ALL OUT). No quantity, no price, no
// account: the engine computes the quantity from its sell ledger (CLAUDE.md, never-break rule 3).
const Exit = Schema.Struct({
  positionId: Id,
  step: Schema.Union([
    Schema.Literals(["0", "1", "2", "3", "4", "5", "6"]),
    Schema.Literal("ALL_OUT"),
  ]),
});

const STEP_INDEX = { "0": 0, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6 } as const;

const Cancel = Schema.Struct({ intentId: Schema.String.check(Schema.isPattern(INTENT_ID)) });

const fields = (form: FormData, names: readonly string[]) =>
  Object.fromEntries(names.map((name) => [name, form.get(name)]));

export const actions: Actions = {
  salir: async (event) => {
    requireUser(event);
    const form = await event.request.formData();
    const parsed = Schema.decodeUnknownResult(Exit)(fields(form, ["positionId", "step"]));
    if (parsed._tag === "Failure")
      return fail(400, { message: "Los datos enviados no son válidos." });
    const { positionId, step } = parsed.success;

    const sent = await engineFor(env.ENGINE, event)
      .exit({ mode: "SIM", positionId, step: step === "ALL_OUT" ? step : STEP_INDEX[step] })
      // The order may have left before the failure: the screen shows what the engine holds.
      .catch(() => null);
    if (sent === null) {
      return fail(502, {
        title: "Verificando la orden",
        message: "No pudimos confirmar si la orden salió. Revisa tus órdenes pendientes.",
      });
    }
    if (!sent.ok) return fail(422, { message: sent.message });
    const result = sent.value;
    if (result.status === "BLOCKED")
      return fail(409, { message: exitBlockMessage(result.reasons) });
    if (result.status === "DONE_ZERO") {
      return { notice: "Este paso redondea a cero: no se envió ninguna orden." };
    }
    const outcome = exitOutcome(result.state);
    return outcome.ok
      ? { notice: outcome.message }
      : fail(409, { title: outcome.title, message: outcome.message });
  },

  cancelar: async (event) => {
    requireUser(event);
    const form = await event.request.formData();
    const parsed = Schema.decodeUnknownResult(Cancel)(fields(form, ["intentId"]));
    if (parsed._tag === "Failure")
      return fail(400, { message: "Los datos enviados no son válidos." });

    const sent = await engineFor(env.ENGINE, event)
      .cancel({ mode: "SIM", intentId: parsed.success.intentId })
      .catch(() => null);
    if (sent === null) {
      return fail(502, {
        title: "No se pudo confirmar la cancelación",
        message: "No pudimos confirmar la cancelación. Revisa tus órdenes pendientes.",
      });
    }
    if (!sent.ok) return fail(422, { message: sent.message });
    if (sent.value.status === "BLOCKED") {
      return fail(409, { message: exitBlockMessage(sent.value.reasons) });
    }
    const outcome = cancelOutcome(sent.value.state);
    return outcome.ok
      ? { notice: outcome.message }
      : fail(409, { title: outcome.title, message: outcome.message });
  },
};

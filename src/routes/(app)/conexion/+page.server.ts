import { fail, isHttpError, redirect } from "@sveltejs/kit";
import { resolve } from "$app/paths";
import { env } from "cloudflare:workers";
import { Schema } from "effect";
import { connectionErrorFor } from "#lib/server/connection-errors.ts";
import { engineFor } from "#lib/server/engine.ts";
import { guardErrors, requireFreshSession } from "#lib/server/guards.ts";
import type { Actions, PageServerLoad, RequestEvent } from "./$types";

const callbackUrl = () => `${new URL(env.APP_ORIGIN).origin}/conexion/callback`;

const expiry = new Intl.DateTimeFormat("es", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "America/New_York",
});

export const load: PageServerLoad = async (event) => {
  const { locals, url, setHeaders } = event;
  if (!locals.user || locals.user.banned) redirect(303, resolve("/acceso"));
  // Accounts of one client: never cached by a shared proxy.
  setHeaders({ "cache-control": "no-store" });

  const result = await engineFor(env.ENGINE, event)
    .connection({ mode: "SIM" })
    .catch(() => null);
  if (result === null) {
    const error = connectionErrorFor("BROKER_UNAVAILABLE")?.message ?? null;
    return { connection: null, callbackUrl: callbackUrl(), error };
  }
  if (!result.ok) return { connection: null, callbackUrl: callbackUrl(), error: result.message };

  const view = result.value;
  return {
    connection:
      view.status === "CONNECTED"
        ? {
            status: view.status,
            accounts: view.accounts,
            // null is "unknown or non-expiring" until a refresh shows the key's policy (#18).
            expiresAt: view.refreshExpiresAt === null ? null : expiry.format(view.refreshExpiresAt),
          }
        : { status: view.status },
    callbackUrl: callbackUrl(),
    error: connectionErrorFor(url.searchParams.get("error"))?.message ?? null,
  };
};

const Credentials = Schema.Struct({
  clientId: Schema.String.check(Schema.isMinLength(1)),
  clientSecret: Schema.String.check(Schema.isMinLength(1)),
});

/** Sensitive actions need a session from the last 10 minutes; say how to get one instead of a 401 page. */
function staleSession(event: RequestEvent) {
  try {
    requireFreshSession(event);
    return null;
  } catch (error) {
    if (isHttpError(error, 401)) {
      return fail(401, { code: guardErrors.reauthRequired.code, message: error.body.message });
    }
    throw error;
  }
}

/** An engine rejection (DO storage, D1) is a broker-side problem to the client, never a 500 page. */
const unavailable = () =>
  fail(502, {
    code: "BROKER_UNAVAILABLE",
    message: connectionErrorFor("BROKER_UNAVAILABLE")?.message ?? "",
  });

export const actions: Actions = {
  // The secret goes from this request straight into the engine. It is never stored, logged,
  // returned or put in the redirect: only the engine's authorize URL (client_id, state) leaves.
  connect: async (event) => {
    const stale = staleSession(event);
    if (stale) return stale;

    const form = await event.request.formData();
    const input = Schema.decodeUnknownResult(Credentials)({
      clientId: form.get("clientId"),
      clientSecret: form.get("clientSecret"),
    });
    const invalid = fail(400, {
      code: "INVALID_INPUT",
      message: "Escribe tu API key y tu secreto de TradeStation.",
    });
    if (input._tag === "Failure") return invalid;

    const result = await engineFor(env.ENGINE, event)
      .beginConnection({
        mode: "SIM",
        clientId: input.success.clientId.trim(),
        clientSecret: input.success.clientSecret.trim(),
        origin: new URL(env.APP_ORIGIN).origin,
      })
      .catch(() => null);
    if (result === null) return unavailable();
    if (!result.ok) {
      return result.code === "INVALID_INPUT"
        ? invalid
        : fail(502, { code: result.code, message: result.message });
    }
    // The engine builds this URL; the allowlist keeps any other destination from ever being followed.
    redirect(303, result.value.authorizeUrl, { external: ["https://signin.tradestation.com"] });
  },

  disconnect: async (event) => {
    const stale = staleSession(event);
    if (stale) return stale;
    const result = await engineFor(env.ENGINE, event)
      .disconnect({ mode: "SIM" })
      .catch(() => null);
    if (result === null) return unavailable();
    if (!result.ok) return fail(502, { code: result.code, message: result.message });
    return { disconnected: true, revoked: result.value.revoked };
  },
};

import { fail, isHttpError, redirect } from "@sveltejs/kit";
import { resolve } from "$app/paths";
import { env } from "cloudflare:workers";
import { Schema } from "effect";
import { CONNECT_REDIRECT_MODE } from "#lib/domain/config.ts";
import { connectRedirectUri, parsePastedRedirect } from "#lib/domain/connect-redirect.ts";
import {
  connectionErrorFor,
  connectionErrors,
  isConnectionErrorCode,
  type ConnectionErrorCode,
} from "#lib/server/connection-errors.ts";
import { engineFor } from "#lib/server/engine.ts";
import { guardErrors, requireFreshSession, requireUser } from "#lib/server/guards.ts";
import type { Actions, PageServerLoad, RequestEvent } from "./$types";

/** Shown only when the client must register our callback on their key (decision D35). */
const callbackUrl = () =>
  CONNECT_REDIRECT_MODE === "registered" ? connectRedirectUri(env.APP_ORIGIN) : null;

const expiry = new Intl.DateTimeFormat("es", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "America/New_York",
});

export const load: PageServerLoad = async (event) => {
  const { locals, url, setHeaders, parent } = event;
  if (!locals.user || locals.user.banned) redirect(303, resolve("/acceso"));
  // Accounts of one client: never cached by a shared proxy.
  setHeaders({ "cache-control": "no-store" });

  // Read once by the layout; this page only formats it.
  const { connection: result } = await parent();
  if (result === null) {
    const error = connectionErrorFor("BROKER_UNAVAILABLE")?.message ?? null;
    return { connection: null, callbackUrl: callbackUrl(), error };
  }
  if (!result.ok) return { connection: null, callbackUrl: callbackUrl(), error: result.message };

  const view = result.view;
  return {
    connection:
      view.status === "CONNECTED"
        ? {
            status: view.status,
            health: view.health,
            entriesBlocked: view.entriesBlocked,
            accounts: view.accounts,
            // Connecting sets connect time + 24 h (conservative, #21); null only on rows stored before that.
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
        redirectUri: connectRedirectUri(env.APP_ORIGIN),
      })
      .catch(() => null);
    if (result === null) return unavailable();
    if (!result.ok) {
      return result.code === "INVALID_INPUT"
        ? invalid
        : fail(502, { code: result.code, message: result.message });
    }
    // The engine builds this URL; the allowlist keeps any other destination from ever being followed.
    const authorizeUrl = result.value.authorizeUrl;
    if (CONNECT_REDIRECT_MODE === "registered") {
      redirect(303, authorizeUrl, { external: ["https://signin.tradestation.com"] });
    }
    // Paste mode: the page opens TradeStation in a new tab and waits for the pasted address.
    return { authorizeUrl };
  },

  // The pasted address holds the one-time code: it is parsed here and never echoed, stored,
  // logged or audited. A failure returns a code and a Spanish message, nothing the client typed.
  paste: async (event) => {
    requireUser(event);
    const form = await event.request.formData();
    const pasted = form.get("redirect");
    const fail400 = (code: ConnectionErrorCode) =>
      fail(400, { code, message: connectionErrors[code], awaitingPaste: true });
    const parsed = parsePastedRedirect(typeof pasted === "string" ? pasted : "");
    if (!parsed.ok) {
      return fail400(
        parsed.reason === "DENIED"
          ? "AUTHORIZATION_DENIED"
          : parsed.reason === "MALFORMED" || parsed.reason === "MISSING_CODE"
            ? "PASTE_INVALID"
            : "STATE_INVALID",
      );
    }

    // The state is consumed in the engine before anything else; a rejection must not become a 500.
    const result = await engineFor(env.ENGINE, event)
      .completeConnection({
        mode: "SIM",
        code: parsed.code,
        state: parsed.state,
        redirectUri: connectRedirectUri(env.APP_ORIGIN),
      })
      .catch(() => null);
    if (result === null) return fail400("BROKER_UNAVAILABLE");
    if (!result.ok) {
      return fail400(
        result.code === "INVALID_INPUT"
          ? "STATE_INVALID"
          : isConnectionErrorCode(result.code)
            ? result.code
            : "BROKER_UNAVAILABLE",
      );
    }
    redirect(303, resolve("/(app)/conexion"));
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

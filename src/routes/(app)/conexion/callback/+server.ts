import { redirect } from "@sveltejs/kit";
import { resolve } from "$app/paths";
import { env } from "cloudflare:workers";
import { Schema } from "effect";
import { engineFor } from "#lib/server/engine.ts";
import { isConnectionErrorCode, type ConnectionErrorCode } from "#lib/server/connection-errors.ts";
import type { RequestHandler } from "./$types";

const Callback = Schema.Struct({
  code: Schema.String.check(Schema.isMinLength(1)),
  state: Schema.String.check(Schema.isMinLength(1)),
});

const back = (error?: ConnectionErrorCode): never =>
  redirect(
    303,
    error ? `${resolve("/(app)/conexion")}?error=${error}` : resolve("/(app)/conexion"),
  );

/**
 * TradeStation sends the browser back here with `code` and `state` in the URL. The state only
 * means something in the session user's own engine, so a foreign, missing, expired or reused one
 * is refused there. Whatever happens, the browser leaves this URL at once with a bare redirect.
 */
export const GET: RequestHandler = async (event) => {
  const { locals, url, setHeaders } = event;
  setHeaders({ "referrer-policy": "no-referrer", "cache-control": "no-store" });
  if (!locals.user || locals.user.banned) redirect(303, resolve("/acceso"));

  // `error` is the user declining at TradeStation; its description is not shown.
  if (url.searchParams.has("error")) return back("AUTHORIZATION_DENIED");

  const params = Schema.decodeUnknownResult(Callback)({
    code: url.searchParams.get("code"),
    state: url.searchParams.get("state"),
  });
  if (params._tag === "Failure") return back("STATE_INVALID");

  // The state is already consumed; a rejection (D1, undecryptable secret) must not become a 500.
  const result = await engineFor(env.ENGINE, event)
    .completeConnection({
      mode: "SIM",
      code: params.success.code,
      state: params.success.state,
      origin: new URL(env.APP_ORIGIN).origin,
    })
    .catch(() => null);
  if (result === null) return back("BROKER_UNAVAILABLE");
  if (result.ok) return back();
  // INVALID_INPUT here means a state or code the engine's own checks refuse, same as a bad state.
  return back(
    result.code === "INVALID_INPUT"
      ? "STATE_INVALID"
      : isConnectionErrorCode(result.code)
        ? result.code
        : "BROKER_UNAVAILABLE",
  );
};

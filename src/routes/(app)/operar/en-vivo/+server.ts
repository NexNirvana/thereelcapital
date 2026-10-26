import { json } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import { engineFor } from "#lib/server/engine.ts";
import { requireUser } from "#lib/server/guards.ts";
import type { RequestHandler } from "./$types";

// The live-price socket (D47). The session is checked here, the socket is handed to the Durable
// Object named after that session's user, and from then on the browser can only say what it
// watches: the engine answers with prices it read from the broker. Display only.
const noStore = { "cache-control": "no-store" } as const;

export const GET: RequestHandler = async (event) => {
  if (!event.locals.user)
    return json({ status: "unauthenticated" }, { status: 401, headers: noStore });
  requireUser(event);

  if (event.request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return json({ status: "invalid" }, { status: 426, headers: noStore });
  }
  // A socket carries the session cookie from any site that opens it, so only this origin may.
  if (event.request.headers.get("origin") !== event.url.origin) {
    return json({ status: "forbidden" }, { status: 403, headers: noStore });
  }

  // A fresh request: nothing of the browser's (cookies, headers) goes on to the engine.
  const upstream = await engineFor(env.ENGINE, event)
    .fetch(new Request("https://engine.invalid/live", { headers: { upgrade: "websocket" } }))
    .catch(() => null);
  if (upstream === null) return json({ status: "unavailable" }, { status: 502, headers: noStore });
  if (upstream.status !== 101 || upstream.webSocket === null) {
    return json({ status: "unavailable" }, { status: 503, headers: noStore });
  }
  return new Response(null, { status: 101, webSocket: upstream.webSocket });
};

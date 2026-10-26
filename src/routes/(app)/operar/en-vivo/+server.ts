import { json } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import { engineFor } from "#lib/server/engine.ts";
import { requireUser } from "#lib/server/guards.ts";
import { handOffLiveSocket } from "#lib/server/live-handoff.ts";
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

  const handoff = await handOffLiveSocket(engineFor(env.ENGINE, event));
  if (handoff.kind === "unavailable") {
    return json({ status: "unavailable" }, { status: handoff.status, headers: noStore });
  }
  return new Response(null, { status: 101, webSocket: handoff.webSocket });
};

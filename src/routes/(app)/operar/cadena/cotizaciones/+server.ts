import { json } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import { ChainQuery, ISO_DATE, UNDERLYING } from "#lib/server/chain-query.ts";
import { decode } from "#lib/server/decode.ts";
import { engineFor } from "#lib/server/engine.ts";
import { requireUser } from "#lib/server/guards.ts";
import type { RequestHandler } from "./$types";

// The live bid and ask of one expiration's chain (D46). Display only: the same read-only engine
// call the page load makes, and the engine lists the strikes once and then reads only quotes.
// Choosing a contract still carries just its symbol; the order is priced when it is sent.
const noStore = { "cache-control": "no-store" } as const;

export const GET: RequestHandler = async (event) => {
  if (!event.locals.user)
    return json({ status: "unauthenticated" }, { status: 401, headers: noStore });
  requireUser(event);

  const query = decode(ChainQuery, Object.fromEntries(event.url.searchParams));
  const underlying = (query.subyacente ?? "").trim().toUpperCase();
  const expiration = query.vencimiento ?? "";
  if (!UNDERLYING.test(underlying) || !ISO_DATE.test(expiration)) {
    return json({ status: "invalid" }, { status: 400, headers: noStore });
  }

  const chain = await engineFor(env.ENGINE, event)
    .optionChain({ mode: "SIM", underlying, expiration })
    .catch(() => null);
  if (chain === null) return json({ status: "unavailable" }, { status: 502, headers: noStore });
  if (!chain.ok) {
    // A broker that cannot be reached is a failed read (the screen slows down); a refusal such as
    // an unknown expiration is an answer.
    const status = chain.code === "BROKER_UNAVAILABLE" ? 502 : 200;
    return json({ status: "unavailable", message: chain.message }, { status, headers: noStore });
  }
  const { receivedAt, strikes } = chain.value;
  return json({ status: "ready", chain: { receivedAt, strikes } }, { headers: noStore });
};

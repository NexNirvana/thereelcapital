import { json } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import { blockMessage } from "#lib/ui/new-entry.ts";
import { decode } from "#lib/server/decode.ts";
import { ASSET_TYPE, EntryQuery, SYMBOL, sizeChoiceArg } from "#lib/server/entry-query.ts";
import { choiceApplied } from "#lib/domain/sizing.ts";
import { SIZE_CHOICE_MISMATCH } from "#lib/ui/live-entry.ts";
import { engineFor } from "#lib/server/engine.ts";
import { requireUser } from "#lib/server/guards.ts";
import type { RequestHandler } from "./$types";

// The live price of the entry on screen (D46). Display only: it carries the same fields the page
// load shows (never the intent id) and nothing the browser sends is a price or a quantity. The
// order itself is still sized by the engine from a fresh ask when it is sent.
const noStore = { "cache-control": "no-store" } as const;

export const GET: RequestHandler = async (event) => {
  if (!event.locals.user)
    return json({ status: "unauthenticated" }, { status: 401, headers: noStore });
  requireUser(event);

  const query = decode(EntryQuery, Object.fromEntries(event.url.searchParams));
  const symbol = (query.simbolo ?? "").trim().toUpperCase();
  if (query.cuenta === undefined || !SYMBOL.test(symbol)) {
    return json({ status: "invalid" }, { status: 400, headers: noStore });
  }

  const prepared = await engineFor(env.ENGINE, event)
    .prepareEntry({
      mode: "SIM",
      accountId: query.cuenta,
      symbol,
      assetType: ASSET_TYPE[query.tipo ?? "acciones"],
      ...sizeChoiceArg(query.tamano),
    })
    .catch(() => null);
  if (prepared === null) return json({ status: "unavailable" }, { status: 502, headers: noStore });
  // A broker that cannot be reached is a failed read (the screen slows down), not a business block.
  if (!prepared.ok && prepared.code === "BROKER_UNAVAILABLE") {
    return json({ status: "unavailable" }, { status: 502, headers: noStore });
  }
  if (!prepared.ok) {
    return json({ status: "blocked", message: prepared.message }, { headers: noStore });
  }
  if (prepared.value.status === "BLOCKED") {
    return json(
      { status: "blocked", message: blockMessage(prepared.value.reasons) },
      { headers: noStore },
    );
  }
  // An engine that ignored the choice would show a quantity the order would not follow (D51).
  if (!choiceApplied(query.tamano ?? "full", prepared.value.sizeChoice)) {
    return json({ status: "blocked", message: SIZE_CHOICE_MISMATCH }, { headers: noStore });
  }
  const {
    symbol: preparedSymbol,
    qty,
    sizeMicros,
    sizeChoice,
    askMicros,
    assetType,
  } = prepared.value;
  return json(
    {
      status: "ready",
      preview: { symbol: preparedSymbol, qty, sizeMicros, sizeChoice, askMicros, assetType },
      receivedAt: Date.now(),
    },
    { headers: noStore },
  );
};

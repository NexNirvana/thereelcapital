import { env } from "cloudflare:workers";
import { engineFor } from "#lib/server/engine.ts";
import type { LayoutServerLoad } from "./$types";

/** Health of the client's TradeStation connection for the top bar; `undefined` when unreadable. */
export const load: LayoutServerLoad = async (event) => {
  const { locals } = event;
  if (!locals.user || locals.user.banned) return { health: undefined };
  const result = await engineFor(env.ENGINE, event)
    .connection({ mode: "SIM" })
    .catch(() => null);
  if (result === null || !result.ok) return { health: undefined };
  return { health: result.value.status === "CONNECTED" ? result.value.health : null };
};

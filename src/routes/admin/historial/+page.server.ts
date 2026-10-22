import { env } from "cloudflare:workers";
import { listClients } from "#lib/server/admin-clients.ts";
import {
  AdminHistoryQuery,
  filtersOf,
  readAdminHistory,
  type HistoryReader,
} from "#lib/server/admin-history.ts";
import { decode } from "#lib/server/decode.ts";
import { engineForClient } from "#lib/server/engine.ts";
import { requireAdmin } from "#lib/server/guards.ts";
import type { PageServerLoad } from "./$types";

// The admin addresses each client's engine by that client's id, as the guard allows only admins
// to; the arguments are the same filters the client's own history takes (never SIZE or prices).
const readClientHistory =
  (event: Parameters<typeof requireAdmin>[0]): HistoryReader =>
  (clientId, args) =>
    engineForClient(env.ENGINE, event, clientId).history(args);

export const load: PageServerLoad = async (event) => {
  requireAdmin(event);
  // Every client's orders: never cached by a shared proxy.
  event.setHeaders({ "cache-control": "no-store" });

  const query = decode(AdminHistoryQuery, Object.fromEntries(event.url.searchParams));
  const filters = filtersOf(query);
  const clients = await listClients(env.DB);
  const page = await readAdminHistory(clients, filters, query.despues, readClientHistory(event));
  const next = new URLSearchParams(
    Object.entries({ ...filters, despues: page.nextCursor ?? "" }).filter(
      ([, value]) => value !== "",
    ),
  );
  return {
    filters,
    filtered: Object.values(filters).some((value) => value !== ""),
    clients: clients.map(({ id, email }) => ({ id, email })),
    page,
    first: query.despues === undefined,
    nextQuery: page.nextCursor === null ? null : next.toString(),
  };
};

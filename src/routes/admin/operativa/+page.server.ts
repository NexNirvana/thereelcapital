import { env } from "cloudflare:workers";
import { listClients } from "#lib/server/admin-clients.ts";
import { startOverviews } from "#lib/server/admin-operations.ts";
import { engineForClient } from "#lib/server/engine.ts";
import { requireAdmin } from "#lib/server/guards.ts";
import type { PageServerLoad } from "./$types";

// Read-only. SvelteKit runs this in parallel with the layout load, so it guards itself.
export const load: PageServerLoad = async (event) => {
  requireAdmin(event);
  event.setHeaders({ "cache-control": "no-store" });
  const clients = await listClients(env.DB);
  // Every client is asked, connected or not: a client that disconnected keeps its positions and
  // orders (engine/src/connection.ts), and only its Durable Object knows them. The rows stream in,
  // so the slowest object delays only its own row.
  return { rows: startOverviews(clients, (id) => engineForClient(env.ENGINE, event, id)) };
};

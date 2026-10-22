import { env } from "cloudflare:workers";
import { listClients } from "#lib/server/admin-clients.ts";
import { fetchOverviews } from "#lib/server/admin-operations.ts";
import { engineForClient } from "#lib/server/engine.ts";
import { requireAdmin } from "#lib/server/guards.ts";
import type { PageServerLoad } from "./$types";

// Read-only. SvelteKit runs this in parallel with the layout load, so it guards itself.
export const load: PageServerLoad = async (event) => {
  requireAdmin(event);
  event.setHeaders({ "cache-control": "no-store" });
  const clients = await listClients(env.DB);
  const rows = await fetchOverviews(clients, (id) => engineForClient(env.ENGINE, event, id));
  return { rows };
};

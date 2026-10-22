import { fail } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import { createUserWith } from "#lib/server/activation.ts";
import { listOtherAdmins } from "#lib/server/admin-client-access.ts";
import { createClientFromForm, listClients } from "#lib/server/admin-clients.ts";
import { createAuth } from "#lib/server/auth.ts";
import { fetchOverviews } from "#lib/server/admin-operations.ts";
import { engineForClient } from "#lib/server/engine.ts";
import { connectionKey } from "#lib/domain/overview.ts";
import { requireAdmin } from "#lib/server/guards.ts";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async (event) => {
  const { user } = requireAdmin(event);
  event.setHeaders({ "cache-control": "no-store" });
  const [clients, admins] = await Promise.all([
    listClients(env.DB),
    listOtherAdmins(env.DB, user.id),
  ]);
  // Only clients with a stored connection are asked; the rest are «Sin conectar» without waking
  // their Durable Object. A slow or failing object shows as «No disponible» for that row alone.
  const asked = await fetchOverviews(
    clients.filter((client) => client.hasConnection === 1),
    (id) => engineForClient(env.ENGINE, event, id),
  );
  const overviewById = new Map(asked.map((row) => [row.id, row.overview]));
  return {
    clients: clients.map((client) => ({
      id: client.id,
      email: client.email,
      access: client.access,
      connection: connectionKey(overviewById.get(client.id) ?? null),
    })),
    admins,
  };
};

export const actions: Actions = {
  create: async (event) => {
    // The activation link is in this response only: it must not be cached or stored anywhere.
    event.setHeaders({ "cache-control": "no-store" });
    const result = await createClientFromForm(
      event,
      {
        db: env.DB,
        origin: env.APP_ORIGIN,
        createUser: createUserWith(createAuth(env)),
      },
      Object.fromEntries(await event.request.formData()),
    );
    if (!result.ok) {
      const { status, code, message } = result.error;
      return fail(status, { code, message });
    }
    const { email, link, expiresAt } = result;
    return { created: { email, link, expiresAt } };
  },
};

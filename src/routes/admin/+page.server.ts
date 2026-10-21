import { fail } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import { createUserWith } from "#lib/server/activation.ts";
import { createClientFromForm, listClients } from "#lib/server/admin-clients.ts";
import { createAuth } from "#lib/server/auth.ts";
import { requireAdmin } from "#lib/server/guards.ts";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async (event) => {
  requireAdmin(event);
  event.setHeaders({ "cache-control": "no-store" });
  return { clients: await listClients(env.DB) };
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

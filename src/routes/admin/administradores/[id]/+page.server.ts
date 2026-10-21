import { error, fail } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import { activationUrl } from "#lib/server/activation-link.ts";
import { getAdminSummary, recoverAdmin } from "#lib/server/admin-client-access.ts";
import { requireAdmin } from "#lib/server/guards.ts";
import type { Actions, PageServerLoad } from "./$types";

// Recovery of another admin (D31). Same rules as the client page: requireAdmin in every load and
// action, a fresh session for the mutation, and the link only in the one response that shows it.
export const load: PageServerLoad = async (event) => {
  const { user } = requireAdmin(event);
  // One's own account has no recovery page; the action refuses it too (`OWN_ACCOUNT`).
  if (event.params.id === user.id)
    error(404, "Administrador no encontrado.", { code: "NOT_FOUND" });
  event.setHeaders({ "cache-control": "no-store" });
  return { admin: await getAdminSummary(env.DB, event.params.id) };
};

export const actions: Actions = {
  recover: async (event) => {
    event.setHeaders({ "cache-control": "no-store" });
    const result = await recoverAdmin(
      event,
      { db: env.DB },
      event.params.id,
      Object.fromEntries(await event.request.formData()),
    );
    if (!result.ok) {
      const { status, code, message } = result.error;
      return fail(status, { code, message });
    }
    const { token, expiresAt } = result.issued;
    return { issued: { link: activationUrl(env.APP_ORIGIN, token), expiresAt } };
  },
};

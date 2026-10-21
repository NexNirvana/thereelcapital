import { fail } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import { activationUrl } from "#lib/server/activation-link.ts";
import {
  deactivateClient,
  generateLink,
  getClientDetail,
  reactivateClient,
  recoverClient,
  revokeAllSessions,
  revokeLink,
  revokeSession,
  type Issued,
  type Outcome,
} from "#lib/server/admin-client-access.ts";
import { requireAdmin } from "#lib/server/guards.ts";
import type { Actions, PageServerLoad, RequestEvent } from "./$types";

// Every load and action calls requireAdmin (inside the access functions for actions), because
// SvelteKit runs them in parallel with the layout load. The client id is the URL's, validated
// against the user table there; nothing else names a target.
export const load: PageServerLoad = async (event) => {
  requireAdmin(event);
  event.setHeaders({ "cache-control": "no-store" });
  return { client: await getClientDetail(env.DB, event.params.id) };
};

const context = () => ({ db: env.DB, secret: env.BETTER_AUTH_SECRET });
const form = async (event: RequestEvent) => Object.fromEntries(await event.request.formData());

// A link is in this response only: it must not be cached or stored anywhere.
function respond(event: RequestEvent, action: string, result: Outcome | Issued) {
  event.setHeaders({ "cache-control": "no-store" });
  if (!result.ok) {
    const { status, code, message } = result.error;
    return fail(status, { action, code, message });
  }
  if ("issued" in result) {
    const { token, expiresAt } = result.issued;
    return { action, issued: { link: activationUrl(env.APP_ORIGIN, token), expiresAt } };
  }
  return { action };
}

export const actions: Actions = {
  generateLink: async (event) =>
    respond(event, "generateLink", await generateLink(event, context(), event.params.id)),
  revokeLink: async (event) =>
    respond(event, "revokeLink", await revokeLink(event, context(), event.params.id)),
  deactivate: async (event) =>
    respond(event, "deactivate", await deactivateClient(event, context(), event.params.id)),
  reactivate: async (event) =>
    respond(event, "reactivate", await reactivateClient(event, context(), event.params.id)),
  revokeSession: async (event) =>
    respond(
      event,
      "revokeSession",
      await revokeSession(event, context(), event.params.id, await form(event)),
    ),
  revokeAllSessions: async (event) =>
    respond(event, "revokeAllSessions", await revokeAllSessions(event, context(), event.params.id)),
  recover: async (event) =>
    respond(
      event,
      "recover",
      await recoverClient(event, context(), event.params.id, await form(event)),
    ),
};

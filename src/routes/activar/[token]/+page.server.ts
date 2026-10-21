import { redirect } from "@sveltejs/kit";
import { resolve } from "$app/paths";
import { env } from "cloudflare:workers";
import { isLinkOfToken } from "#lib/server/activation.ts";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, params, setHeaders }) => {
  // The token is in this URL: keep it out of Referer headers and caches, and out of the Cloudflare
  // Web Analytics beacon, which the edge does not inject into `no-transform` responses
  // (docs/auth-and-security.md#sessions-and-requests). It is never returned from here either; the
  // page reads it from the address bar and sends it to the redeem endpoint.
  setHeaders({ "referrer-policy": "no-referrer", "cache-control": "no-store, no-transform" });
  // Someone already signed in has nothing to activate.
  if (locals.user && !locals.user.banned) redirect(303, resolve("/(app)/operar"));
  // A live enrollment session resumes at the passkey step (reload mid-activation) only when it
  // came from the link in this URL; a session from another link must not be mistaken for it.
  const invitationId = locals.enrollment?.invitationId ?? null;
  const enrolling =
    invitationId !== null &&
    (await isLinkOfToken(env.DB, invitationId, params.token, env.BETTER_AUTH_SECRET));
  return { enrolling };
};

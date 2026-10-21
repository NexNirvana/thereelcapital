import { building } from "$app/env";
import { getRequestEvent } from "$app/server";
import type { Handle } from "@sveltejs/kit/hooks";
import { sveltekitCookies, svelteKitHandler } from "better-auth/svelte-kit";
import { env } from "cloudflare:workers";
import { createAuth } from "#lib/server/auth.ts";

export const handle: Handle = async ({ event, resolve }) => {
  // sveltekitCookies goes last so cookies set by Better Auth reach SvelteKit responses.
  const auth = createAuth(env, {
    baseURL: event.url.origin,
    trailingPlugins: [sveltekitCookies(getRequestEvent)],
  });

  // The user and role come only from the verified session; routes never read ids from the client.
  const session = await auth.api.getSession({ headers: event.request.headers });
  event.locals.session = session?.session ?? null;
  event.locals.user = session?.user ?? null;

  return svelteKitHandler({ auth, event, resolve, building });
};

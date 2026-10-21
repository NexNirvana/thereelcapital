import { redirect } from "@sveltejs/kit";
import { resolve } from "$app/paths";
import { requireAdmin } from "#lib/server/guards.ts";
import type { LayoutServerLoad } from "./$types";

// Every /admin page: anonymous visitors go to /acceso, clients get 403. Page loads and actions
// call requireAdmin themselves as well (an action without a session answers 401), because
// SvelteKit runs them in parallel with this load rather than after it.
export const load: LayoutServerLoad = (event) => {
  if (!event.locals.user) redirect(303, resolve("/acceso"));
  requireAdmin(event);
  return {};
};

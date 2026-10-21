import { requireAdmin } from "#lib/server/guards.ts";
import type { LayoutServerLoad } from "./$types";

// Every /admin page: only admins get past (403 for a client, 401 without a session). Page loads
// and actions call requireAdmin themselves as well, because SvelteKit runs them in parallel with
// this load rather than after it.
export const load: LayoutServerLoad = (event) => {
  requireAdmin(event);
  return {};
};

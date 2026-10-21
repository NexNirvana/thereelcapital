import { redirect } from "@sveltejs/kit";
import { resolve } from "$app/paths";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals }) => {
  // Placeholder until #17 builds the screen: only a signed-in, active client sees it.
  if (!locals.user || locals.user.banned) redirect(303, resolve("/acceso"));
  return {};
};

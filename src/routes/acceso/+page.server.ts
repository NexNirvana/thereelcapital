import { redirect } from "@sveltejs/kit";
import { resolve } from "$app/paths";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals }) => {
  // Someone already signed in has nothing to do here.
  if (locals.user && !locals.user.banned) redirect(303, resolve("/(app)/operar"));
  return {};
};

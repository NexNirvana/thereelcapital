import { redirect } from "@sveltejs/kit";
import { resolve } from "$app/paths";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals }) => {
  // Someone already signed in has nothing to recover.
  if (locals.user && !locals.user.banned) redirect(303, resolve("/(app)/operar"));
  // A live enrollment session (reload mid-recovery) resumes at the passkey step.
  return { enrolling: locals.enrollment !== null };
};

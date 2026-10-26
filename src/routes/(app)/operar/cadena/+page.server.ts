import { redirect } from "@sveltejs/kit";
import { resolve } from "$app/paths";
import type { PageServerLoad } from "./$types";

// The chain lives in the Opciones tab of /operar now. Old links keep working: the parameters the
// two screens share travel along, and /operar validates them like any other.
const KEPT = ["cuenta", "subyacente", "vencimiento"] as const;

export const load: PageServerLoad = ({ url }) => {
  const target = new URLSearchParams({ tipo: "opciones" });
  for (const name of KEPT) {
    const value = url.searchParams.get(name);
    if (value !== null) target.set(name, value);
  }
  redirect(308, `${resolve("/(app)/operar")}?${target}`);
};

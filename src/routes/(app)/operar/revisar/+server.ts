import { redirect } from "@sveltejs/kit";
import { resolve } from "$app/paths";
import type { RequestHandler } from "./$types";

// The review step no longer exists: Nueva entrada sends the order itself. Old links and bookmarks
// land on it with the same entry. Only the three entry parameters are carried over, and the page
// validates them again.
const ENTRY_PARAMS = ["tipo", "cuenta", "simbolo"] as const;

export const GET: RequestHandler = ({ url }) => {
  const carried = new URLSearchParams();
  for (const name of ENTRY_PARAMS) {
    const value = url.searchParams.get(name);
    if (value !== null) carried.set(name, value);
  }
  const query = carried.size === 0 ? "" : `?${carried}`;
  redirect(303, `${resolve("/(app)/operar")}${query}`);
};
